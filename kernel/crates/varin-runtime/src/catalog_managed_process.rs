//! The original Operation's physical executor association. Process state and tree receipts
//! remain in Storage; this is neither a process registry nor another receipt ledger.
use super::*;
use crate::execution::{CompletionKind, ToolExecutionContext};
use serde::Deserialize;

const PENDING_MANAGED_PROCESSES_QUERY: &str =
    "SELECT body FROM operations INDEXED BY unsettled_managed_processes";

pub(super) const UNSETTLED_MANAGED_PROCESS: &str = "json_extract(body,'$.managed_process') IS NOT NULL AND json_extract(body,'$.effect')!='none' AND coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NodeBinding {
    pub executable: String,
    pub worker_path: String,
    pub worker_identity: String,
    pub configuration_identity: String,
}
impl NodeBinding {
    pub fn validate(&self) -> Result<()> {
        if [
            &self.executable,
            &self.worker_path,
            &self.worker_identity,
            &self.configuration_identity,
        ]
        .iter()
        .any(|value| value.is_empty())
        {
            return Err(RuntimeError::Invalid(
                "Node execution binding is incomplete".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManagedProcessKind {
    ProcessJob,
    /// This environment's owner is the enclosing Operation's actual Run.
    ScriptEnvironment {
        node: NodeBinding,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedProcess {
    pub purpose: ManagedProcessKind,
    /// Bound only by the actual Storage process receipt, never user script output.
    pub kernel_epoch: Option<String>,
}
impl ManagedProcess {
    pub fn is_environment(&self) -> bool {
        matches!(self.purpose, ManagedProcessKind::ScriptEnvironment { .. })
    }
}
pub fn require_process(op: &Operation) -> Result<&ManagedProcess> {
    let link = op
        .managed_process
        .as_ref()
        .ok_or_else(|| RuntimeError::Conflict("Operation has no managed process binding".into()))?;
    let intent = tool_content::ToolIntent::from_operation(op)?;
    if intent.contract().completion != CompletionKind::Job
        || op.executor.as_deref() != Some(intent.call().name.as_str())
        || match &link.purpose {
            ManagedProcessKind::ProcessJob => {
                !(op.execution_owner==Some(ExecutorOwner::Kernel)||matches!(&op.execution_owner,Some(ExecutorOwner::External{identity,..}) if identity.starts_with("source:"))) || op.lifetime != Lifetime::Thread
            }
            ManagedProcessKind::ScriptEnvironment { node } => {
                node.validate()?;
                !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
                    || op.lifetime != Lifetime::Environment
            }
        }
    {
        return Err(RuntimeError::Conflict(
            "Original managed process executor or lifetime changed".into(),
        ));
    }
    Ok(link)
}
impl Catalog {
    pub fn bind_managed_process(
        &mut self,
        context: &ToolExecutionContext,
        kind: ManagedProcessKind,
    ) -> Result<Operation> {
        self.bind_managed_process_source(context, kind, None)
    }
    /// Record the exact selected local view of one deferred builtin script
    /// environment before the Host dispatches its process. The Run stays dormant.
    pub fn bind_deferred_script_environment(
        &mut self,
        context: &ToolExecutionContext,
        node: NodeBinding,
        source: launches::SourceSelection,
    ) -> Result<Operation> {
        self.bind_managed_process_source(context, ManagedProcessKind::ScriptEnvironment { node }, Some(source))
    }
    fn bind_managed_process_source(
        &mut self,
        context: &ToolExecutionContext,
        kind: ManagedProcessKind,
        prepared: Option<launches::SourceSelection>,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        if op.run_id != context.run_id
            || intent.origin() != &context.origin
            || op.phase != OperationPhase::Running
            || op.cancel_requested
            || run.cancel_requested
            || run.state.terminal()
        {
            return Err(RuntimeError::Conflict(
                "Managed process invocation is unavailable".into(),
            ));
        }
        let launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &op.run_id)?;
        if let Some(source) = prepared.as_ref() {
            let default = launch.selection.lazy_work_location.as_ref()
                .ok_or_else(|| RuntimeError::Conflict("Original deferred script location is missing".into()))?;
            source.validate()?;
            let delegated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
                [&run.thread_id], |row| row.get(0))?;
            if !matches!(kind, ManagedProcessKind::ScriptEnvironment { .. })
                || !matches!(context.origin, crate::execution::ToolOrigin::ModelStep { .. })
                || context.origin.operation_id(&intent.call().call_id) != op.id
                || op.executor.as_deref() != Some("script_open") || intent.call().name != "script_open"
                || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
                || op.epoch != run.epoch || op.epoch != self.epoch || op.call_completion.is_some()
                || !principals::thread_has_host_authority(&tx, &run.thread_id)? || delegated
                || launch.selection.source.is_some() || !default.resource_owner.is_local()
                || source.resource_owner != default.resource_owner || source.mode != SourceMode::LiveRoot
                || source.live_root.as_ref().is_none_or(|root| root.canonical_root != default.path)
                || source.execution_workspace_id != source.workspace_id
                || default.workspace_id.as_ref().is_some_and(|workspace| *workspace != source.workspace_id)
                || op.resource_source.as_ref().is_some_and(|old| old != source)
            {
                return Err(RuntimeError::Conflict("Deferred script source differs from the original admitted invocation".into()));
            }
        } else if !matches!(kind, ManagedProcessKind::ProcessJob)
            && !launch.selection.source.as_ref().is_some_and(|source| source.mode != SourceMode::FixedBranch)
        {
            return Err(RuntimeError::Conflict(
                "Managed process requires its admitted source; script environments require a physical source".into(),
            ));
        }
        if matches!(kind, ManagedProcessKind::ProcessJob) {
            // ProcessJob's first command may still be preparing its original
            // fixed source view in Storage. Binding records ownership, not cwd readiness.
            let source = op.resource_source.as_ref().or(launch.selection.source.as_ref())
                .ok_or_else(|| RuntimeError::Conflict("Process has no admitted execution source".into()))?;
            let matching = match (&source.resource_owner, &op.execution_owner) {
                (launches::SourceResourceOwner::Local, Some(ExecutorOwner::Kernel)) => true,
                (launches::SourceResourceOwner::ManagedHost{host_id,..}, Some(ExecutorOwner::External{identity,epoch})) => !epoch.is_empty() && identity.strip_prefix(&format!("source:{host_id}:source-authority:")).is_some_and(|suffix|!suffix.is_empty()),
                _ => false,
            };
            if !matching { return Err(RuntimeError::Conflict("Process executor differs from its frozen resource Host".into())); }
        }
        if let Some(old) = &op.managed_process {
            if old.purpose != kind {
                return Err(RuntimeError::Conflict(
                    "Managed process binding changed".into(),
                ));
            }
            require_process(&op)?;
            return Ok(op);
        }
        if let Some(source) = prepared {
            op.resource_source = Some(source);
        }
        op.managed_process = Some(ManagedProcess {
            purpose: kind,
            kernel_epoch: None,
        });
        require_process(&op)?;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(&tx, &op.id, op.revision, "process.bound", Value::Null)?;
        tx.commit()?;
        Ok(op)
    }
    pub fn confirm_process_epoch(&mut self, id: &str, epoch: &str) -> Result<Operation> {
        if epoch.is_empty() {
            return Err(RuntimeError::Invalid(
                "Physical process epoch is missing".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", id)?;
        let binding = require_process(&op)?;
        if let Some(original) = &binding.kernel_epoch {
            if original != epoch {
                return Err(RuntimeError::Conflict(
                    "Physical process epoch changed".into(),
                ));
            }
            return Ok(op);
        }
        op.managed_process
            .as_mut()
            .expect("checked process")
            .kernel_epoch = Some(epoch.into());
        op.revision += 1;
        put(&tx, "operations", id, &op)?;
        event(&tx, id, op.revision, "process.epoch_bound", Value::Null)?;
        tx.commit()?;
        Ok(op)
    }
    pub fn pending_managed_processes(&self) -> Result<Vec<String>> {
        let mut query = self.db.prepare_cached(&format!(
            "{PENDING_MANAGED_PROCESSES_QUERY} WHERE {UNSETTLED_MANAGED_PROCESS} ORDER BY id"
        ))?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let op: Operation = serde_json::from_str(&row?)?;
            require_process(&op)?;
            Ok(op.id)
        })
        .collect()
    }
    pub fn closing_script_environments(&mut self) -> Result<Vec<String>> {
        let tx = self.db.transaction()?;
        let operations = {
            let mut query = tx.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.managed_process.purpose.kind')='script_environment' AND json_extract(o.body,'$.effect')!='none' AND coalesce(json_extract(o.body,'$.external_receipt.executor_stopped'),0)=0 AND (json_extract(o.body,'$.cancel_requested')=1 OR json_extract(r.body,'$.cancel_requested')=1 OR json_extract(r.body,'$.state') IN ('completed','failed','cancelled'))")?;
            let rows = query
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| Ok(serde_json::from_str::<Operation>(&row?)?))
                .collect::<Result<Vec<_>>>()?;
            rows
        };
        let mut ids = Vec::new();
        for op in operations {
            if !op
                .managed_process
                .as_ref()
                .is_some_and(ManagedProcess::is_environment)
                || op
                    .external_receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.executor_stopped)
                || op.effect == Effect::None
            {
                continue;
            }
            require_process(&op)?;
            let run: Run = record(&tx, "runs", &op.run_id)?;
            if op.cancel_requested || run.cancel_requested || run.state.terminal() {
                request_cancel_operation_in(&tx, &op.id)?;
                ids.push(op.id);
            }
        }
        tx.commit()?;
        Ok(ids)
    }
    /// Internal investigations have no independent terminal owner after their report.
    pub fn closing_retrieval_processes(&mut self) -> Result<Vec<String>> {
        let tx = self.db.transaction()?;
        let ids = {
            let mut query = tx.prepare("SELECT p.id FROM operations p JOIN delegated_executions d ON d.run_id=p.run_id JOIN operations owner ON owner.id=d.child_operation_id WHERE json_extract(owner.body,'$.executor')='code_retrieval' AND (json_extract(d.body,'$.report') IS NOT NULL OR json_extract(owner.body,'$.cancel_requested')=1) AND json_extract(p.body,'$.managed_process') IS NOT NULL AND json_extract(p.body,'$.effect')!='none' AND coalesce(json_extract(p.body,'$.external_receipt.executor_stopped'),0)=0")?;
            let ids = query.query_map([], |row| row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            ids
        };
        for id in &ids { request_cancel_operation_in(&tx,id)?; }
        tx.commit()?;
        Ok(ids)
    }
}

impl Catalog {
    /// Original dispatched caller and its immutable intent, with no body reads under Catalog.
    pub fn managed_process_caller(
        &self,
        id: &str,
        owner: &ExecutorOwner,
        active: bool,
    ) -> Result<(Operation, ToolExecutionContext)> {
        let op = self.operation(id)?;
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        let run = self.run(&op.run_id)?;
        if op.execution_owner.as_ref() != Some(owner)
            || !matches!(owner, ExecutorOwner::External { .. })
            || (active
                && (op.epoch != run.epoch
                    || op.cancel_requested
                    || run.cancel_requested
                    || run.state.terminal()
                    || op.phase != OperationPhase::Running
                    || op.call_completion.is_some()))
        {
            return Err(RuntimeError::Conflict(
                "Original script invocation is unavailable".into(),
            ));
        }
        let context = ToolExecutionContext {
            run_id: op.run_id.clone(),
            operation_id: op.id.clone(),
            origin: intent.origin().clone(),
        };
        Ok((op, context))
    }
    pub fn require_script_environment(
        &self,
        caller: &ToolExecutionContext,
        id: &str,
        active: bool,
    ) -> Result<Operation> {
        let op = self.operation(id)?;
        let link = require_process(&op)?;
        if !link.is_environment()
            || op.run_id != caller.run_id
            || (active
                && (op.cancel_requested
                    || op.phase != OperationPhase::Running
                    || !op.handed_off
                    || op
                        .external_receipt
                        .as_ref()
                        .is_some_and(|receipt| receipt.executor_stopped)))
        {
            return Err(RuntimeError::Conflict(
                "Script environment is not active in its original Run".into(),
            ));
        }
        Ok(op)
    }
    pub fn accept_managed_process(
        &mut self,
        id: &str,
        owner: &ExecutorOwner,
        physical_epoch: &str,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        self.confirm_process_epoch(id, physical_epoch)?;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", id)?;
        if op.execution_owner.as_ref() != Some(owner) || !require_process(&op)?.is_environment() {
            return Err(RuntimeError::Conflict(
                "Script environment executor changed".into(),
            ));
        }
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        let completion = result_content::ToolCompletionMetadata::JobAccepted {
            operation_id: op.id.clone(),
            phase: "accepted".into(),
            effect: Effect::Confirmed,
            lifetime: op.lifetime,
            content_ref: Some(prepared.reference.clone()),
        };
        if let Some(original) = &op.call_completion {
            if matches!(
                original,
                result_content::ToolCompletionMetadata::JobAccepted { .. }
            ) && original != &completion
            {
                return Err(RuntimeError::Conflict(
                    "Managed process acceptance changed".into(),
                ));
            }
        } else {
            op.call_completion = Some(completion.clone());
            if let crate::execution::ToolOrigin::ModelStep { request_id } = intent.origin() {
                let receipt = result_content::ToolReceiptMetadata {
                    request_id: request_id.clone(),
                    call_id: intent.call().call_id.clone(),
                    completion,
                };
                tx.execute("UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2 AND receipt IS NULL",
                    params![request_id, intent.call().call_id, encode(&receipt)?])?;
            }
        }
        op.handed_off = true;
        op.effect = Effect::Confirmed;
        op.result = Some(OperationResultMetadata::Content {
            reference: prepared.reference,
        });
        if let Some(receipt) = op.external_receipt.clone() {
            execution_persistence::apply_external_terminal(&mut op, &receipt);
        } else {
            op.phase = OperationPhase::Running;
            op.outcome = None;
        }
        op.revision += 1;
        put(&tx, "operations", id, &op)?;
        event(&tx, id, op.revision, "process.accepted", Value::Null)?;
        tx.commit()?;
        Ok(op)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_scan_uses_only_the_unsettled_index() {
        let root = std::env::temp_dir().join(format!("varin-pending-managed-plan-{}", id()));
        let db = Catalog::open(&root).unwrap();
        let detail: String = db.db.query_row(
            &format!("EXPLAIN QUERY PLAN {PENDING_MANAGED_PROCESSES_QUERY} WHERE {UNSETTLED_MANAGED_PROCESS} ORDER BY id"),
            [],
            |row| row.get(3),
        ).unwrap();
        assert!(detail.contains("unsettled_managed_processes"), "{detail}");
        assert!(db.pending_managed_processes().unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
