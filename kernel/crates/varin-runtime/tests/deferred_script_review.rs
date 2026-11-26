#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::{
    launches::{LaunchSelection, LazyWorkLocation, LiveRoot, SourceResourceOwner, SourceSelection},
    managed_process::{ManagedProcessKind, NodeBinding},
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, ExecutorOwner, RunState, SourceMode, SubmitInput, Lifetime};

fn begin_fixture(path: &str, name: &str) -> (std::path::PathBuf, Catalog, ToolExecutionContext) {
    let root = std::env::temp_dir().join(format!("deferred-script-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "branch").unwrap();
    let mut launch: LaunchSelection = serde_json::from_value(json!({
        "extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"model",
        "configuration_generation":1,"tool_schema_generation":1,
        "tools":[{"name":name,"version":"1","description":"Fixture script environment","output_schema":null,
            "metadata":null,"schema":{"type":"object"}}],"policy":{"name":"fixture","version":"1"},"source":null
    })).unwrap();
    launch.lazy_work_location = Some(LazyWorkLocation {
        resource_owner: SourceResourceOwner::Local, path: path.into(), workspace_id: Some("workspace".into()),
    });
    let receipt = db.submit_with_launch(&SubmitInput {
        key:"input".into(),thread_id:"thread".into(),branch_id:"branch".into(),expected_head:None,
        input:json!("Open environment"),configuration:json!({}),
    },Some(launch.clone())).unwrap();
    let origin = ToolOrigin::ModelStep { request_id:"request".into() };
    let context = ToolExecutionContext { run_id:receipt.run_id, operation_id:origin.operation_id("cell"),origin };
    let range = HistoryRange { branch_id:"branch".into(), ancestor_id:None,leaf_id:Some(receipt.input_id) };
    let binding: RequestBinding = serde_json::from_value(json!({
        "child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":"fixture","provider_family":"fixture","model":"model","credential_ref":null,
        "configuration_generation":1,"tool_schema_generation":1,"tools":launch.tools,"instruction_sources":[],
        "memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range
    })).unwrap();
    let call = ToolCall { call_id:"cell".into(),name:name.into(),schema_version:"1".into(),arguments:json!({}) };
    for record in [
        ExecutionRecord::StateChanged { state:RunState::Runnable,waiting_on:None },
        ExecutionRecord::RequestPrepared { snapshot:RequestSnapshot { view:RequestView {
            request_id:"request".into(),run_id:context.run_id.clone(),origin:RequestOrigin::Conversation{
                compaction:None,step:0,history_range:range},binding,history:vec![]
        },serialized:json!({}).into() }.into() },
        ExecutionRecord::ModelDispatched { request_id:"request".into() },
        ExecutionRecord::ModelFinished {
            request_id:"request".into(),outcome:ModelOutcome::Completed,finish_reason:Some(FinishReason::ToolCalls),
            items:vec![ProviderItem {id:"cell".into(),content:Content::ToolCall{call:call.clone()},opaque:None}],
            interrupted_deltas:vec![],usage:UsageReceipt::default(),failure:None,
        },
        ExecutionRecord::ToolAdmitted { context:context.clone(),tool:AdmittedTool { call,
            contract:ToolContract { name:name.into(),schema_version:"1".into(),read_only:false,
                completion:CompletionKind::Job,lifetime:Lifetime::Environment,resources:vec![] }} },
        ExecutionRecord::ToolDispatched { context:context.clone(),
            executor_owner:ExecutorOwner::External{identity:"configured-host".into(),epoch:"host-epoch".into()} },
    ] {
        db.commit_execution(&context.run_id,db.epoch(),&record).unwrap();
    }
    (root,db,context)
}
fn prepared(path: &str) -> SourceSelection {
    SourceSelection {
        native_scope:None,resource_owner:SourceResourceOwner::Local,environment_run_id:None,mode:SourceMode::LiveRoot,
        live_root:Some(LiveRoot {host_id:"host".into(),canonical_root:path.into(),root_id:"physical".into()}),
        workspace_id:"workspace".into(),execution_workspace_id:"workspace".into(),branch_id:None,revision:None,
    }
}
fn node() -> NodeBinding {
    NodeBinding { executable:"node".into(),worker_path:"worker".into(),worker_identity:"worker-identity".into(),configuration_identity:"installed-node".into() }
}
#[test]
fn deferred_script_binds_one_original_physical_operation_never_the_run() {
    let (root, mut db, context) = begin_fixture("/recorded", "script_open");
    assert!(db.bind_managed_process(&context, ManagedProcessKind::ScriptEnvironment { node:node() }).is_err());
    assert!(db.bind_deferred_script_environment(&context,node(),prepared("/foreign")).is_err());
    let mut wrong = prepared("/recorded");
    wrong.workspace_id = "foreign".into();
    wrong.execution_workspace_id = "foreign".into();
    assert!(db.bind_deferred_script_environment(&context,node(),wrong).is_err());
    assert!(db.operation(&context.operation_id).unwrap().managed_process.is_none());

    let selected = prepared("/recorded");
    let admitted = db.bind_deferred_script_environment(&context,node(),selected.clone()).unwrap();
    assert_eq!(admitted.resource_source.as_ref(),Some(&selected));
    assert_eq!(db.bind_deferred_script_environment(&context,node(),selected.clone()).unwrap().revision,admitted.revision);
    let mut moved = selected.clone();
    moved.live_root.as_mut().unwrap().root_id = "another-physical-root".into();
    assert!(db.bind_deferred_script_environment(&context,node(),moved).is_err());
    assert!(db.launch_metadata(&context.run_id).unwrap().unwrap().selection.source.is_none());
    drop(db);
    let db = Catalog::open(&root).unwrap();
    let op = db.operation(&context.operation_id).unwrap();
    assert_eq!(db.original_operation_source(&op).unwrap().as_ref(),Some(&selected));
    drop(db); std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn raw_job_cannot_claim_deferred_script_source() {
    let (root, mut db, context) = begin_fixture("/recorded", "raw_evaluator");
    assert!(db.bind_deferred_script_environment(&context,node(),prepared("/recorded")).is_err());
    let op = db.operation(&context.operation_id).unwrap();
    assert!(op.resource_source.is_none() && op.managed_process.is_none());
    drop(db); std::fs::remove_dir_all(root).unwrap();
}
