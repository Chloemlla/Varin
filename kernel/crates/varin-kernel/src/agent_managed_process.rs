//! Trusted Host script domain commands. The original Operation and Storage process own
//! their facts; no script registry, grant issuer or secondary receipt journal lives here.
use super::*;
use varin_runtime::catalog::managed_process::{ManagedProcessKind, require_process};
use varin_runtime::execution::{CancellationToken, ToolExecutionContext};
use varin_runtime::{Effect, ExecutorOwner, ExternalReceipt, Outcome};

const DORMANT_SCRIPT_CONFIGURATION: &str = "deferred-local-script-v1";
pub(crate) fn dormant_script_tool(tool: &varin_runtime::execution::ToolSchema) -> bool {
    let service = match tool.name.as_str() {
        "script_open" => "varin.script.open",
        "script_run" => "varin.script.run",
        "script_close" => "varin.script.close",
        _ => return false,
    };
    tool.requirements.is_none() && tool.metadata.as_ref().is_some_and(|metadata| metadata.service_id == service)
}

pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    resources: crate::tools::KernelResourceClient,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let catalog = runtime.catalog();
    let lock = || {
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))
    };
    let read_operation = |op| -> Result<Value, KernelError> {
        let read = lock()?.capture_operation_read(op);
        Ok(serde_json::to_value(read.load().map_err(domain)?)?)
    };
    if cancelled.load(Ordering::Acquire)
        && matches!(
            method,
            "runtime.managed_process.begin" | "runtime.managed_process.cell"
        )
    {
        return Err(KernelError::Cancelled);
    }
    match method {
        "runtime.managed_process.pending" => {
            let _: KernelEmptyParams = serde_json::from_value(params)?;
            let reads = {
                let db = lock()?;
                db.pending_managed_processes()
                    .map_err(domain)?
                    .into_iter()
                    .map(|id| db.operation(&id))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?
                    .into_iter()
                    .filter(|op| {
                        op.managed_process
                            .as_ref()
                            .is_some_and(|p| p.is_environment())
                    })
                    .map(|op| db.capture_operation_read(op))
                    .collect::<Vec<_>>()
            };
            Ok(serde_json::to_value(
                reads
                    .into_iter()
                    .map(|r| r.load())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(domain)?,
            )?)
        }
        "runtime.managed_process.begin" => {
            let p: ManagedProcessBeginParams = serde_json::from_value(params)?;
            p.node.validate().map_err(domain)?;
            let (operation, context, launch, invocation) = {
                let db = lock()?;
                let (op, context) = db
                    .managed_process_caller(&p.operation_id, &p.execution_owner, true)
                    .map_err(domain)?;
                let launch = db
                    .capture_launch(&op.run_id)
                    .map_err(domain)?
                    .ok_or_else(|| KernelError::Authorization("Script source is missing".into()))?;
                let intent = varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op)
                    .map_err(domain)?;
                let invocation = db
                    .capture_tool_invocation(&context, &intent.call().call_id)
                    .map_err(domain)?;
                (op, context, launch, invocation)
            };
            let launch = launch.load().map_err(domain)?;
            let invocation = invocation.load().map_err(domain)?;
            let prepared_source = p.prepared_source;
            let selected =
                launch.selection.extension_bindings.iter().find(|binding| {
                    let exact = Some(binding.tool.name.as_str()) == operation.executor.as_deref()
                        && binding.tool.version == invocation.call.schema_version
                        && invocation.tools.iter().any(|tool| tool == &binding.tool)
                        && invocation.frozen.source == launch.selection.source;
                    exact && if prepared_source.is_some() {
                        binding.extension_id == "varin.builtin.scripts"
                            && binding.service_id == "varin.script.open"
                            && binding.tool.name == "script_open"
                            && dormant_script_tool(&binding.tool)
                            && binding.configuration_identity.as_deref() == Some(DORMANT_SCRIPT_CONFIGURATION)
                            && p.node.configuration_identity != DORMANT_SCRIPT_CONFIGURATION
                            && launch.selection.source.is_none()
                    } else {
                        binding.configuration_identity.as_deref() == Some(p.node.configuration_identity.as_str())
                            && binding.tool.requirements.as_ref().is_some_and(|r| {
                                r.process && r.accepts(launch.selection.source.as_ref())
                            })
                    }
                });
            if selected.is_none() {
                return Err(KernelError::Authorization(
                    "Script binding differs from its original selected declaration/configuration"
                        .into(),
                ));
            }
            let op = {
                let mut db = lock()?;
                db.validate_tool_invocation(&invocation, true)
                    .map_err(domain)?;
                if let Some(source) = prepared_source {
                    let source = varin_runtime::catalog::launches::SourceSelection {
                        resource_owner: source.resource_owner,
                        native_scope: source.native_scope,
                        environment_run_id: source.environment_run_id.and_then(|value| value.0),
                        workspace_id: source.workspace_id,
                        execution_workspace_id: source.execution_workspace_id,
                        branch_id: source.branch_id.0,
                        revision: source.revision.0.map(u64::try_from).transpose()
                            .map_err(|_| KernelError::Protocol("source revision must be nonnegative".into()))?,
                        mode: source.mode,
                        live_root: source.live_root.0.map(|root| varin_runtime::catalog::launches::LiveRoot {
                            host_id: root.host_id, canonical_root: root.canonical_root, root_id: root.root_id,
                        }),
                    };
                    db.bind_deferred_script_environment(&context, p.node, source)
                } else {
                    db.bind_managed_process(&context, ManagedProcessKind::ScriptEnvironment { node: p.node })
                }.map_err(domain)?
            };
            read_operation(op)
        }
        "runtime.managed_process.cell" => {
            let p: ManagedProcessCellParams = serde_json::from_value(params)?;
            let (op, context, read) = {
                let db = lock()?;
                let (op, c) = db
                    .managed_process_caller(&p.operation_id, &p.execution_owner, true)
                    .map_err(domain)?;
                let read = db.capture_operation_read(op.clone());
                (op, c, read)
            };
            if op.executor.as_deref() != Some(if p.closing { "script_close" } else { "script_run" }) {
                return Err(KernelError::Authorization("Script cell operation kind differs from its original call".into()));
            }
            let original = read.load().map_err(domain)?;
            let selected = original.intent["call"]["arguments"]["environmentId"].as_str()
                .ok_or_else(|| KernelError::Authorization("Original script environment is missing".into()))?;
            let resolved = lock()?.resolve_managed_process_reference(selected).map_err(domain)?;
            if resolved != p.environment_id {
                return Err(KernelError::Authorization(
                    "Cell environment differs from its original arguments".into(),
                ));
            }
            let env = {
                let db = lock()?;
                db.managed_process_caller(&op.id, &p.execution_owner, true)
                    .map_err(domain)?;
                db.require_script_environment(&context, &p.environment_id, !p.closing)
                    .map_err(domain)?
            };
            if p.closing {
                // The cell still delivers its output/error. Only its subordinate
                // calls stop; cancelling the cell itself would race that receipt.
                lock()?.nested_tools().cancel(&op.id, &p.execution_owner)
                    .map_err(|error| KernelError::Operation(error.to_string()))?;
            }
            read_operation(env)
        }
        "runtime.managed_process.accept" => {
            let p: ManagedProcessAcceptParams = serde_json::from_value(params)?;
            let binding: crate::tools::ToolBinding = serde_json::from_value(p.tool_binding)?;
            let (op, context) = {
                lock()?
                    .managed_process_caller(&p.operation_id, &p.execution_owner, false)
                    .map_err(domain)?
            };
            let process = observe(&catalog, &resources, &op, &context, Some(&binding))?;
            let link = require_process(&op).map_err(domain)?;
            let ManagedProcessKind::ScriptEnvironment { node } = &link.purpose else {
                return Err(KernelError::Authorization(
                    "Expected script environment".into(),
                ));
            };
            let body = json!({"environmentId":op.id,"bindingIdentity":node.configuration_identity});
            let preparation = lock()?.prepare_result_content();
            let prepared = preparation.write_result(&body).map_err(domain)?;
            let epoch = process["kernelEpoch"]
                .as_str()
                .ok_or_else(|| KernelError::Protocol("Process epoch missing".into()))?;
            let op = lock()?
                .accept_managed_process(&op.id, &p.execution_owner, epoch, prepared)
                .map_err(domain)?;
            read_operation(op)
        }
        "runtime.managed_process.terminal" => {
            let p: ManagedProcessTerminalParams = serde_json::from_value(params)?;
            let binding: Option<crate::tools::ToolBinding> = p.tool_binding.map(serde_json::from_value).transpose()?;
            let (op, context) = lock()?
                .managed_process_caller(&p.operation_id, &p.execution_owner, false)
                .map_err(domain)?;
            if !require_process(&op).map_err(domain)?.is_environment() {
                return Err(KernelError::Authorization(
                    "Expected script environment".into(),
                ));
            }
            if op
                .external_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.executor_stopped)
            {
                return read_operation(op);
            }
            let process = observe(&catalog, &resources, &op, &context, binding.as_ref())?;
            let physical_epoch = process["kernelEpoch"]
                .as_str()
                .ok_or_else(|| KernelError::Protocol("Process epoch missing".into()))?;
            lock()?
                .confirm_process_epoch(&op.id, physical_epoch)
                .map_err(domain)?;
            let tree_stopped = process["writerActive"] == false && process["treeConfirmed"] == true;
            let stopped = tree_stopped && p.callbacks_stopped;
            // Unknown is the original uncertainty receipt. New physical evidence stays in
            // Storage until callback drain can refine it, rather than rewriting Unknown.
            if !stopped && op.external_receipt.is_some() {
                return read_operation(op);
            }
            let ExecutorOwner::External { epoch, .. } = p.execution_owner else {
                unreachable!("validated external owner")
            };
            let prepared = lock()?.prepare_result_content();
            let receipt=prepared.write_external_receipt(ExternalReceipt{executor:op.executor.clone().expect("validated executor"),
                identity:op.id.clone(),epoch,outcome:if stopped {if op.cancel_requested {Outcome::Cancelled} else {Outcome::Succeeded}} else {Outcome::Indeterminate},
                effect:if stopped {Effect::Confirmed} else {Effect::Unknown},
                result:json!({"environmentId":op.id,"process":process,"callbacksStopped":p.callbacks_stopped}).into()}).map_err(domain)?;
            let result = lock()?
                .record_external_receipt_prepared(&op.id, receipt, stopped)
                .map_err(domain)?;
            read_operation(result)
        }
        _ => Err(KernelError::Protocol(
            "Unknown managed process method".into(),
        )),
    }
}
fn observe(
    catalog: &Arc<Mutex<varin_runtime::Catalog>>,
    resources: &crate::tools::KernelResourceClient,
    op: &varin_runtime::OperationMetadata,
    context: &ToolExecutionContext,
    binding: Option<&crate::tools::ToolBinding>,
) -> Result<Value, KernelError> {
    let managed = {
        let db = catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?;
        let run = db.run(&op.run_id).map_err(domain)?;
        let source = db.original_operation_source(op).map_err(domain)?
            .ok_or_else(|| KernelError::Authorization("Original source missing".into()))?;
        if let Some(binding) = binding {
            if binding.run_id != op.run_id || binding.thread_id != run.thread_id || source != binding.source_selection()? {
                return Err(KernelError::Authorization("Managed process source binding changed".into()));
            }
        }
        !source.resource_owner.is_local()
    };
    if managed {
        // Revocation fences late spawn/input. Original physical receipts remain
        // observable after revocation without re-admitting project access.
        let receipt = resources.remote_operation_receipt(&op.id, "observe")?
            .ok_or_else(|| KernelError::Authorization("Original script resource owner unavailable".into()))?;
        let process = &receipt["process"];
        if receipt["accepted"] != true || process["processId"] != op.id || process["mode"] != "pipe" {
            return Err(KernelError::Authorization("Original script process acceptance is unconfirmed".into()));
        }
        return Ok(process.clone());
    }
    let binding = binding.ok_or_else(|| KernelError::Authorization("Local script source binding missing".into()))?;
    resources
        .observe_process(
            binding,
            context,
            &op.id,
            &op.run_id,
            None,
            None,
            false,
            &CancellationToken::default(),
        )
        .map_err(|e| KernelError::Authorization(e.to_string()))
}

/// The original Run-end owner requests physical stop without awaiting any Host callback.
/// Independent Thread ProcessJobs never appear in this typed environment query.
pub(super) fn close_ended_environments(
    runtime: &RunSupervisor,
    resources: &crate::tools::KernelResourceClient,
) -> Result<(), KernelError> {
    let catalog = runtime.catalog();
    let candidates = {
        let mut db = catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?;
        let mut closing = db.closing_script_environments().map_err(domain)?;
        closing.extend(db.closing_retrieval_processes().map_err(domain)?);
        closing
            .into_iter()
            .map(|id| db.operation(&id).map(|op| (id, op.run_id)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(domain)?
    };
    for (id, run) in candidates {
        resources.request_environment_stop(id, run)?;
    }
    Ok(())
}
