//! File references use their resource owner. Workspace reads keep their native scheduler.
use crate::host_query::OwnerChannel;
use crate::resource_references::{self as refs, FileTarget, ReadTarget};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::{launches::SourceSelection, model_references::ReferenceKind};
use varin_runtime::composition::tools::ToolDeclaration;
use varin_runtime::execution::*;
use varin_runtime::execution_capacity::{AdmissionControlGuard, ExecutionClass};
use varin_runtime::output::OutputBody;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

fn error(message: impl ToString) -> ExecutionError { ExecutionError::new("attachment_read", message.to_string()) }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    offset: u64,
    length: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    files: Vec<Value>,
}

pub(crate) fn declaration(workspace: Option<ToolDeclaration>, catalog: Arc<Mutex<Catalog>>, bridge: OwnerChannel) -> ToolDeclaration {
    let schema = workspace.as_ref().map(|entry| entry.schema.clone()).unwrap_or_else(|| {
        crate::tools::KernelToolExecutor::selected_schemas(&[crate::tools::ToolKind::FileRead].into_iter().collect()).remove(0)
    });
    ToolDeclaration::new(schema.clone(), Arc::new(Reader { schema, workspace: workspace.map(|d| d.implementation), catalog, bridge }))
}

struct Reader {
    schema: ToolSchema,
    workspace: Option<Arc<dyn ToolExecutor>>,
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
}

enum BatchItem {
    Workspace,
    Attachment(Read),
    Invalid(ExecutionError),
}

enum Selection {
    Single(Read),
    Batch {
        items: Vec<BatchItem>,
        workspace: Result<Option<Box<dyn PreparedToolCall>>, ExecutionError>,
    },
}

struct Call {
    owner: Arc<Reader>,
    call: ToolCall,
    frozen: FrozenToolContext,
    selection: Selection,
    epoch: u64,
}

impl Reader {
    fn attachment(&self, arguments: &Value) -> Result<Option<Read>, ExecutionError> {
        let Some(reference) = arguments.get("ref") else { return Ok(None) };
        let reference = reference.as_str().ok_or_else(|| error("File reference must be a string"))?;
        let catalog = self.catalog.lock().map_err(error)?;
        let continuation;
        let arguments = if reference.starts_with("read:") {
            let selected = catalog.resolve_model_reference(ReferenceKind::Read, reference).map_err(error)?;
            if selected.owner != "attachment" { return Ok(None); }
            if arguments.as_object().is_none_or(|fields| fields.len() != 1) {
                return Err(error("Use nextRead without changing its fixed selection"));
            }
            let target: ReadTarget = serde_json::from_value(selected.target).map_err(error)?;
            if target.tool != self.schema.name || target.source.is_some() {
                return Err(error("Attachment continuation changed its original reader"));
            }
            continuation = target.arguments;
            &continuation
        } else {
            arguments
        };
        let file = match arguments["ref"].as_str().filter(|reference| reference.starts_with("file:")) {
            Some(reference) => match refs::resolve(&catalog, ReferenceKind::File, reference)? {
                FileTarget::Observation { .. } => return Ok(None),
                FileTarget::Attachment { reference } => Some(reference),
            },
            None => None,
        };
        let mut read = Read::deserialize(arguments).map_err(error)?;
        if let Some(reference) = file { read.reference = reference; }
        if read.reference.trim().is_empty() || read.reference.contains('\0') {
            return Err(error("attachment reference is required"));
        }
        Ok(Some(read))
    }

    fn workspace(&self) -> Result<Arc<dyn ToolExecutor>, ExecutionError> {
        self.workspace.clone().ok_or_else(|| error("A path requires an admitted file Source; use an attachment reference for received files"))
    }
}

impl ToolExecutor for Reader {
    fn bind_call(self: Arc<Self>, call: &ToolCall, frozen: &FrozenToolContext, cancel: &CancellationToken) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        if call.name != self.schema.name || !frozen.tools.iter().any(|schema| {
            schema == &self.schema && call.schema_version == schema.version
                || call.schema_version == "1" && schema.name == call.name && schema.version == "1"
        }) {
            return Err(error("file reader is not selected in this invocation"));
        }
        let selection = if call.arguments.get("files").is_some() {
            let Batch { files } = Batch::deserialize(&call.arguments).map_err(error)?;
            if files.is_empty() { return Err(error("files must contain at least one read")); }
            let items = files.iter().map(|item| match self.attachment(item) {
                Ok(Some(read)) => BatchItem::Attachment(read),
                Ok(None) => BatchItem::Workspace,
                Err(error) => BatchItem::Invalid(error),
            }).collect::<Vec<_>>();
            if items.iter().all(|item| matches!(item, BatchItem::Workspace)) {
                return self.workspace()?.bind_call(call, frozen, cancel);
            }
            let paths = files.into_iter().zip(&items)
                .filter_map(|(request, item)| matches!(item, BatchItem::Workspace).then_some(request))
                .collect::<Vec<_>>();
            let workspace = if paths.is_empty() {
                Ok(None)
            } else {
                let native = ToolCall { arguments: json!({"files": paths}), ..call.clone() };
                self.workspace().and_then(|owner| owner.bind_call(&native, frozen, cancel)).map(Some)
            };
            Selection::Batch { items, workspace }
        } else if let Some(read) = self.attachment(&call.arguments)? {
            Selection::Single(read)
        } else {
            return self.workspace()?.bind_call(call, frozen, cancel);
        };
        let epoch = self.catalog.lock().map_err(error)?.epoch();
        Ok(Box::new(Call { owner: self, call: call.clone(), frozen: frozen.clone(), selection, epoch }))
    }
    fn plan(&self, _: &ToolCall, _: &FrozenToolContext, _: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        Err(error("file read requires its bound invocation"))
    }
    fn prepare(&self, _: &ToolCall, _: &FrozenToolContext, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        Err(error("file read requires its bound invocation"))
    }
    fn authorize(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> Result<(), ExecutionError> {
        Err(error("file read requires its bound invocation"))
    }
    fn execute(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> ToolCompletion {
        ToolCompletion::not_dispatched(error("file read requires its bound invocation"))
    }
}

impl Call {
    fn workspace(&self) -> Option<&dyn PreparedToolCall> {
        match &self.selection {
            Selection::Batch { workspace: Ok(Some(workspace)), .. } => Some(workspace.as_ref()),
            _ => None,
        }
    }
    fn contract(&self) -> ToolContract {
        ToolContract { name: self.call.name.clone(), schema_version: self.call.schema_version.clone(), read_only: true,
            completion: CompletionKind::Result, lifetime: Lifetime::Run, resources: vec![] }
    }
    fn validate_owner(&self, context: &ToolExecutionContext, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(ExecutionError::new("attachment_read_cancelled", "attachment read cancelled"));
        }
        if context.run_id != self.frozen.run_id || context.origin != self.frozen.origin || context.operation_id != context.origin.operation_id(&self.call.call_id) {
            return Err(error("attachment read owner changed"));
        }
        self.owner.catalog.lock().map_err(error)?.validate_resource_snapshot_owner(&context.run_id, self.epoch, &context.origin)
            .map_err(|failure| match failure {
                varin_runtime::RuntimeError::Conflict(_) => ExecutionError::new("attachment_read_cancelled", "Attachment read owner closed"),
                other => error(other),
            })
    }
    fn read_page(&self, context: &ToolExecutionContext, read: &Read, cancel: &CancellationToken) -> Result<OutputBody, ExecutionError> {
        let checkpoint = self.frozen.resource_checkpoint_id.as_deref().filter(|id| !id.is_empty())
            .ok_or_else(|| error("file reader has no frozen resource checkpoint"))?;
        self.validate_owner(context, cancel)?;
        let value = self.owner.bridge.query(json!({"runId":context.run_id,"origin":context.origin,"callId":self.call.call_id,
            "resourceCheckpointId":checkpoint,
            "request":{"kind":"attachment","ref":read.reference,"view":"content","offset":read.offset,"limit":read.length.unwrap_or(65536)}}), cancel)?;
        self.validate_owner(context, cancel)?;
        if value["status"] != "ready" {
            return Err(error(value["reason"].as_str().or(value["message"].as_str()).unwrap_or("Attachment owner could not read the selected version"))
                .with_details(value));
        }
        let mut catalog = self.owner.catalog.lock().map_err(error)?;
        project_read(&mut catalog, &context.run_id, read, value)
    }
}

impl PreparedToolCall for Call {
    fn resource_source(&self) -> Option<&SourceSelection> {
        self.workspace().and_then(PreparedToolCall::resource_source)
    }
    fn plan(&self, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        match self.workspace() {
            Some(workspace) => workspace.plan(cancel),
            None => Ok(ToolPreparation::Ready(self.contract())),
        }
    }
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        match self.workspace() {
            Some(workspace) => workspace.prepare(cancel),
            None => Ok(self.contract()),
        }
    }
    fn execution_class(&self, contract: &ToolContract) -> ExecutionClass {
        self.workspace().map_or(ExecutionClass::Unmetered, |workspace| workspace.execution_class(contract))
    }
    fn watch_admission(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
        match self.workspace() {
            Some(workspace) => workspace.watch_admission(context, contract, cancel),
            None => Ok(None),
        }
    }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool {
        contract.read_only && contract.completion == CompletionKind::Result
            && self.workspace().is_none_or(|workspace| workspace.supports_policy_read(contract))
    }
    fn authorize(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        self.validate_owner(context, cancel)?;
        if let Some(workspace) = self.workspace() { workspace.authorize(context, contract, cancel)?; }
        Ok(())
    }
    fn execute(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> ToolExecutionReceipt {
        let completion = match &self.selection {
            Selection::Single(read) => match self.read_page(context, read, cancel) {
                Ok(content) => ToolCompletion::Result { outcome: Outcome::Succeeded, effect: Effect::None, content },
                Err(failure) => ToolCompletion::Result {
                    outcome: if cancel.is_cancelled() || failure.code == "attachment_read_cancelled" { Outcome::Cancelled } else { Outcome::Failed },
                    effect: Effect::None, content: json!({"error":failure}).into(),
                },
            },
            Selection::Batch { items, workspace } => {
                let workspace_content = match workspace {
                    Ok(Some(workspace)) => {
                        let receipt = workspace.execute(context, contract, cancel);
                        if !receipt.executor_stopped { return receipt; }
                        match receipt.completion {
                            ToolCompletion::Result { content, .. } if content.data["files"].is_array() => Ok(Some(content)),
                            ToolCompletion::NotDispatched { error: Some(error), .. } => Err(error),
                            _ => Err(error("Workspace reader did not return batch results")),
                        }
                    }
                    Ok(None) => Ok(None),
                    Err(error) => Err(error.clone()),
                };
                let mut paths = 0;
                let mut raw = Vec::with_capacity(items.len());
                let mut projected = Vec::with_capacity(items.len());
                for (index, item) in items.iter().enumerate() {
                    let output = match item {
                        BatchItem::Attachment(read) => self.read_page(context, read, cancel),
                        BatchItem::Invalid(error) => Err(error.clone()),
                        BatchItem::Workspace => {
                            let position = paths;
                            paths += 1;
                            workspace_content.as_ref().map_err(Clone::clone).and_then(|batch| {
                                let batch = batch.as_ref().ok_or_else(|| error("Workspace reader is unavailable"))?;
                                let raw = batch.data["files"][position].get("result").ok_or_else(|| error("Workspace read result is missing"))?;
                                let mut output = OutputBody::from(raw.clone());
                                output.model_data = batch.model_data()["files"][position].get("result").cloned();
                                Ok(output)
                            })
                        }
                    };
                    let result = output.unwrap_or_else(|error| json!({
                        "status": if error.code == "attachment_read_cancelled" { "cancelled" } else { "failed" }, "error": error,
                    }).into());
                    projected.push(json!({"index":index, "result":result.model_data()}));
                    raw.push(json!({"index":index, "request":self.call.arguments["files"][index], "result":result.data}));
                }
                let mut completion = crate::tools::read::batch_completion(raw, cancel);
                if let ToolCompletion::Result { content, .. } = &mut completion {
                    content.model_data = Some(json!({"status":content.data["status"], "files":projected}));
                }
                completion
            }
        };
        ToolExecutionReceipt::local(completion, contract)
    }
}

/// Project only the original attachment owner's declared response. Full raw receipts
/// stay available; continuations bind this immutable file and exact byte offset.
fn project_read(catalog:&mut Catalog, holder:&str, read:&Read, value:serde_json::Value)->Result<varin_runtime::output::OutputBody,ExecutionError> {
    let mut attachment:varin_runtime::catalog::attachments::Attachment=serde_json::from_value(value["attachment"].clone()).map_err(error)?;
    if attachment.reference!=read.reference {return Err(error("Attachment owner changed the selected immutable file"));}
    attachment.validate().map_err(error)?;
    let content=&value["content"];
    let next=content["nextOffset"].as_u64().ok_or_else(||error("Attachment owner omitted the original page boundary"))?;
    if content["offset"].as_u64()!=Some(read.offset) || next<read.offset || next>attachment.byte_length
        || content["byteLength"].as_u64()!=Some(attachment.byte_length)
        || content["eof"].as_bool()!=Some(next==attachment.byte_length)
        || next==read.offset && next<attachment.byte_length {
        return Err(error("Attachment owner changed its fixed page boundary"));
    }
    catalog.project_attachments(std::slice::from_mut(&mut attachment),holder).map_err(error)?;
    let reference=attachment.model_ref.as_ref().expect("owner projection").clone();
    let mut projected=value.clone();
    projected["attachment"]=serde_json::to_value(attachment.model_descriptor()).map_err(error)?;
    projected["ref"]=json!(reference);
    projected["content"].as_object_mut().expect("validated content").remove("nextOffset");
    if next<attachment.byte_length {
        projected["nextRead"]=crate::resource_references::continuation(catalog,"attachment","file_read",None,
            json!({"ref":reference,"offset":next,"length":read.length}),holder)?;
    }
    let mut output:varin_runtime::output::OutputBody=value.into();output.model_data=Some(projected);Ok(output)
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn attachment_page_ref_replays_exact_owner_selection_and_rejects_changed_receipts() {
        let root=std::env::temp_dir().join(format!("attachment-continuation-{}",uuid::Uuid::new_v4()));
        let mut catalog=Catalog::open(&root).unwrap();
        let read=Read{reference:"attachment:immutable-version".into(),offset:0,length:Some(3)};
        let page=json!({"status":"ready","attachment":{"ref":read.reference,"filename":"file.txt","mimeType":"text/plain","byteLength":6},
            "content":{"text":"abc","offset":0,"nextOffset":3,"byteLength":6,"eof":false}});
        let output=project_read(&mut catalog,"retained-run",&read,page.clone()).unwrap();
        let again=project_read(&mut catalog,"retained-run",&read,page.clone()).unwrap();assert_eq!(output,again);
        assert_eq!(output.data,page);assert!(!output.model_data().to_string().contains("attachment:immutable-version"));
        let next=output.model_data()["nextRead"]["arguments"].clone();
        let (tx,_rx)=std::sync::mpsc::sync_channel(1);let bridge=OwnerChannel::new("resource",tx);
        let declaration=declaration(None,Arc::new(Mutex::new(catalog)),bridge);
        let schema=declaration.schema.clone();
        // Exercise the same hybrid dispatch router used with no workspace Source.
        let mut call=ToolCall{call_id:"next".into(),name:"file_read".into(),schema_version:schema.version.clone(),arguments:next};
        let frozen=FrozenToolContext{tool_output_visible_bytes:None,execution_environment:None,direct_tools:None,child_dispatch:None,
            resource_activations:vec![],resource_checkpoint_id:Some("original-resource-checkpoint".into()),run_id:"retained-run".into(),
            origin:ToolOrigin::ModelStep{request_id:"original-request".into()},tools:Arc::new(vec![schema]),tool_schema_generation:1,source:None};
        let cancel=CancellationToken::default();
        for _ in 0..2 {assert!(declaration.implementation.clone().bind_call(&call,&frozen,&cancel).is_ok());}
        call.arguments["offset"]=json!(4);assert!(declaration.implementation.clone().bind_call(&call,&frozen,&cancel).is_err());
        drop(declaration);
        let mut catalog=Catalog::open(&root).unwrap();
        let mut changed=page.clone();changed["attachment"]["ref"]=json!("attachment:other");assert!(project_read(&mut catalog,"retained-run",&read,changed).is_err());
        let mut changed=page;changed["content"]["nextOffset"]=json!(7);assert!(project_read(&mut catalog,"retained-run",&read,changed).is_err());
        drop(catalog);std::fs::remove_dir_all(root).unwrap();
    }
}
