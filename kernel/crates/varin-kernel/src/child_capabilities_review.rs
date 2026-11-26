use super::*;
use varin_runtime::execution::*;
fn with_disclosure(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.extend(varin_runtime::tool_disclosure::schemas());
    tools
}

#[test]
fn bot_default_delegation_excludes_main_only_tools_and_still_resolves() {
    let read=schemas().into_iter().find(|schema|schema.name=="file_read").unwrap();
    let dispatch=schemas().into_iter().find(|schema|schema.name=="dispatch").unwrap();
    let wait=schemas().into_iter().find(|schema|schema.name=="wait_child").unwrap();
    let fixture=fixture::Fixture::new_extended_parent_with_schemas(read.clone(),dispatch,wait);
    let mut selection=fixture.db.capture_child_dispatch_invocation(&fixture.context).unwrap().load().unwrap();
    let mut parent=selection.frozen.allowed_delegation.clone();
    parent.extend([crate::bot_work_tools::schema(),crate::agent_goals::schema()]);
    selection.frozen.allowed_delegation=delegated(&parent);
    let mut input=fixture.input.clone();input.tools=None;
    let (_,tools)=crate::collaboration::resolve_selection(&selection,&input).unwrap();
    assert!(tools.contains(&read));
    assert!(!tools.iter().any(|tool|matches!(tool.name.as_str(),"matters"|"goal_report")));
    let root=fixture.root.clone();drop(selection);drop(fixture);std::fs::remove_dir_all(root).unwrap();
}
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;

#[test]
fn available_metadata_is_the_actual_native_directory_and_classifies_real_source_handoffs() {
    let directory = schemas();
    let metadata = descriptors();
    assert_eq!(directory.len(), metadata.len());
    for entry in &metadata {
        assert!(directory
            .iter()
            .any(|tool| tool.name == entry.name && tool.version == entry.version));
    }
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "dispatch")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::None
    );
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "process_write")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::Source
    );
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "question_status")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::None
    );
    let retrieval = metadata
        .iter()
        .find(|tool| tool.name == "code_retrieval")
        .unwrap();
    assert_eq!(retrieval.source_requirement, ChildSourceRequirement::Source);
    assert!(!retrieval.process);
    assert_eq!(
        retrieval.default_presets,
        vec![
            varin_runtime::catalog::dispatch::ChildPresetDefault::Worker,
            varin_runtime::catalog::dispatch::ChildPresetDefault::Retrieval,
            varin_runtime::catalog::dispatch::ChildPresetDefault::Verifier,
            varin_runtime::catalog::dispatch::ChildPresetDefault::ResearchPeer,
        ]
    );
    for name in ["language_definition", "language_references", "language_diagnostics", "language_hover", "language_symbols", "language_document_symbols", "language_call_hierarchy"] {
        assert!(!metadata.iter().any(|tool| tool.name == name));
        assert!(!directory.iter().any(|tool| tool.name == name));
        assert!(select(&[name.into()]).is_err());
        assert!(!varin_runtime::tool_disclosure::is_always_declared(name));
    }
    for name in ["goal_report", "computer", "pi-only"] {
        assert!(select(&[name.into()]).is_err());
    }
}

#[test]
fn explicit_normal_narrowing_keeps_frozen_extensions_and_checks_exact_owning_schema() {
    let available = schemas();
    let read = available
        .iter()
        .find(|tool| tool.name == "file_read")
        .unwrap()
        .clone();
    let dispatch = available
        .iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap()
        .clone();
    let wait = available
        .iter()
        .find(|tool| tool.name == "wait_child")
        .unwrap()
        .clone();
    let f =
        fixture::Fixture::new_extended_parent_with_schemas(read.clone(), dispatch.clone(), wait);
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert!(selected
        .frozen
        .allowed_delegation
        .iter()
        .any(|tool| tool.name == "helper"));
    assert!(crate::collaboration::resolve_selection(&selected, &f.input).is_ok());
    let mut all = f.input.clone();
    all.tools = None;
    let (resolved, full) = crate::collaboration::resolve_selection(&selected, &all).unwrap();
    assert_eq!(resolved.extension_bindings, selected.extension_bindings);
    assert!(full.contains(&selected.extension_bindings[0].tool));
    let mut selected = selected;
    selected.extension_bindings[0].tool.description.push_str(" changed Host declaration");
    assert!(crate::collaboration::resolve_selection(&selected, &all).is_err(),
        "native compatibility cannot replace a changed original Host binding");
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
    let mut changed = read;
    changed.version = "different-owner-version".into();
    let f = fixture::Fixture::new_with_schemas(0, changed, dispatch);
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert!(crate::collaboration::resolve_selection(&selected, &f.input).is_err());
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn routed_parent_grants_only_the_original_native_reader_to_retrieval_and_normal_children() {
    let read = select(&["file_read".into()]).unwrap().remove(0);
    let mut parent_tools = vec![read.clone()];
    crate::work_locations::add_schemas(&mut parent_tools);
    let delegated = delegated(&parent_tools);
    assert_eq!(delegated.len(), 1, "location discovery belongs only to the parent");
    let routed = &delegated[0];

    let f = fixture::Fixture::new_internal_retrieval_with_read(routed.clone());
    let mut selected = f.db.capture_child_dispatch_invocation(&f.context).unwrap().load().unwrap();
    selected.catalog.native_capabilities = descriptors();
    let (_, tools) = crate::collaboration::resolve_selection(&selected, &f.input).unwrap();
    assert_eq!(tools, with_disclosure(vec![read.clone()]));
    assert!(!supports_frozen_builtin(routed, &read), "a child cannot rebind v3 by name");
    assert!(select_frozen(&selected, &[crate::work_locations::NAME.into()], ChildFileRoute::Existing).is_err());

    let mut normal = f.input.clone();
    normal.preset = None;
    normal.tools = Some(vec![read.name.clone()]);
    assert_eq!(crate::collaboration::resolve_selection(&selected, &normal).unwrap().1, tools);
    assert!(selected.frozen.allowed_delegation.contains(routed));

    selected.catalog.native_capabilities.iter_mut().find(|t| t.name == read.name).unwrap().version = "1".into();
    assert!(crate::collaboration::resolve_selection(&selected, &f.input).is_err(),
        "an older frozen catalog cannot acquire the v2 reader");
    selected.catalog.native_capabilities = descriptors();
    let original = selected.frozen.allowed_delegation.iter_mut().find(|t| t.name == read.name).unwrap();
    original.schema["oneOf"][0] = serde_json::json!({"required":["ref"]});
    assert!(crate::collaboration::resolve_selection(&selected, &normal).is_err(),
        "the name/version of a different or narrower frozen parent is not authority");
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn binding_hook_freezes_model_visible_configuration_without_changing_tool_schemas() {
    let directory = schemas();
    let read = directory
        .iter()
        .find(|tool| tool.name == "file_read")
        .unwrap()
        .clone();
    let dispatch = directory
        .iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap()
        .clone();
    let f = fixture::Fixture::new_with_schemas(0, read, dispatch);
    let snapshot: RequestSnapshot = serde_json::from_value(
        f.db.capture_model_step_read("parent-request")
            .unwrap()
            .load_request()
            .unwrap(),
    )
    .unwrap();
    let mut binding = snapshot.view.binding;
    let original_tools = binding.tools.clone();
    let run = f.context.run_id.clone();
    let epoch = f.db.epoch();
    let root = f.root.clone();
    let catalog = std::sync::Arc::new(std::sync::Mutex::new(f.db));
    let hook = BindingPreparation {
        inner: std::sync::Arc::new(NoopContextPreparation),
        catalog: catalog.clone(),
    };
    let context = hook
        .prepare_binding(&run, epoch, &mut binding, &CancellationToken::default())
        .unwrap();
    assert_eq!(binding.tools, original_tools);
    assert!(binding.child_dispatch.is_some());
    let text = context.iter().find_map(|item| match (&item.provenance, &item.content) {
        (Provenance::SystemInstruction { source }, Content::Text { text })
            if source == "child_dispatch_configuration" => Some(text),
        _ => None,
    }).expect("expected visible selection");
    assert!(text.contains("allowed_delegation"));
    assert!(text.contains("fixture-catalog"));
    assert!(!text.contains("credential-ref"));
    assert!(!text.contains("credential-owner"));
    assert!(!text.contains("127.0.0.1"));
    let selected = catalog
        .lock()
        .unwrap()
        .capture_child_dispatch(binding.child_dispatch.as_ref().unwrap());
    assert_eq!(
        selected.load().unwrap().frozen.allowed_delegation,
        original_tools
    );
    drop(hook);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn normal_child_inherits_actual_parent_note_and_plan_declarations() {
    let native = schemas();
    let get = |name: &str| {
        native
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let mut f = fixture::Fixture::new_parent_custom(
        0,
        get("file_read"),
        get("dispatch"),
        false,
        false,
        false,
        |input, launch| {
            input.tools = None;
            launch.tools.retain(|tool| tool.name != "wait_child");
            launch
                .tools
                .extend([get("wait_child"), get("memory"), get("todo")]);
        },
    );
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let (_, tools) = crate::collaboration::resolve_selection(&selected, &f.input).unwrap();
    assert_eq!(delegated(&tools), tools);
    assert!(tools.contains(&crate::memory::schema(true)));
    assert!(tools.contains(&crate::plan::schema()));
    f.launch.tools = tools.clone();
    let child = f.accept();
    let child = f.db.capture_child_read(child).load().unwrap();
    assert_eq!(child.launch.tools, tools);
    assert_eq!(
        child.selected_profile.work_mode,
        varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly
    );
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn shipped_defaults_resolve_actual_declarations_with_their_required_sources() {
    use varin_runtime::catalog::dispatch::{
        ChildModelSource, ChildPreset, ChildPresetDefault, ChildWorkMode,
    };
    let directory = schemas();
    let metadata = descriptors();
    let get = |name: &str| {
        directory
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let f = fixture::Fixture::new_parent_custom(0, get("file_read"), get("dispatch"), false, false, false, |_, launch| {
        // Shipped presets must compare against the owning wait declaration, not the
        // generic fixture's intentionally minimal placeholder schema.
        launch.tools.retain(|tool| tool.name != "wait_child");
        launch.tools.push(get("wait_child"));
    });
    let mut selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    selected.catalog.native_capabilities = metadata.clone();
    for (id, member, mode) in [
        (
            "worker",
            ChildPresetDefault::Worker,
            ChildWorkMode::IsolatedWrite,
        ),
        (
            "retrieval",
            ChildPresetDefault::Retrieval,
            ChildWorkMode::IsolatedWrite,
        ),
    ] {
        // The profile owner projects these members; no second available-name list.
        let tools: Vec<_> = metadata
            .iter()
            .filter(|tool| tool.default_presets.contains(&member))
            .map(|tool| tool.name.clone())
            .collect();
        assert!(!tools.is_empty());
        selected.catalog.presets.push(ChildPreset {
            work_focus: Vec::new(),
            external: None,
            description: None,
            avatar: None,
            tools_source: varin_runtime::catalog::dispatch::ChildPresetToolsSource::Default,
            id: id.into(),
            name: id.into(),
            instructions: String::new(),
            tools: tools.clone(),
            // A retained catalog may still carry the retired placement; it is never consulted.
            retired_work_mode: Some(mode),
            model_source: ChildModelSource::Inherit,
            inherit_base: None,
            model: None,
            unavailable: None,
        });
        let mut input = f.input.clone();
        input.preset = Some(id.into());
        input.tools = None;
        input.work_mode = None;
        let (resolved, executable) =
            crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(resolved.profile.work_mode, ChildWorkMode::Shared);
        assert_eq!(executable.len(), tools.len());
        assert!(executable.iter().all(|tool| directory.contains(tool)));
        assert!(executable.contains(&get("code_retrieval")));
        // An explicit source capability selection stays exact when a preset evolves.
        input.tools = Some(vec!["file_read".into()]);
        let (_, explicit) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(explicit, with_disclosure(vec![get("file_read")]));
        input.tools = Some(vec!["code_retrieval".into()]);
        let (_, explicit) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(explicit, with_disclosure(vec![get("code_retrieval")]));
        input.tools = None;
        assert!(resolved.source_delegation().configured_preset);
        if member == ChildPresetDefault::Worker {
            assert!(executable.contains(&get("file_write")));
            assert!(executable.contains(&get("file_edit")));
            assert!(resolved.source_delegation().process);
        } else {
            assert!(resolved.source_delegation().process);
            assert!(!executable.contains(&get("file_write")));
        }
        // An explicit read-only dispatch narrows the role's default tools to non-physical ones;
        // an explicit physical tool remains exact and is rejected for read-only work.
        input.work_mode = Some(ChildWorkMode::ReadOnly);
        let (read_only, _) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(read_only.profile.work_mode, ChildWorkMode::ReadOnly);
        assert!(!read_only.profile.tools.iter().any(|name| ["process_spawn", "file_write", "file_edit"].contains(&name.as_str())));
        assert!(!read_only.source_delegation().process);
        input.tools = Some(vec!["process_spawn".into()]);
        assert!(crate::collaboration::resolve_selection(&selected, &input).unwrap_err().message.contains("cannot run read-only"));
        input.tools = Some(vec!["file_read".into()]);
        assert!(crate::collaboration::resolve_selection(&selected, &input).is_ok());
        input.tools = None;
        input.work_mode = Some(ChildWorkMode::IsolatedWrite);
        assert_eq!(crate::collaboration::resolve_selection(&selected, &input).unwrap().0.profile.work_mode, ChildWorkMode::IsolatedWrite);
        input.work_mode = None;
    }
    selected.catalog.presets[0].tools = vec!["read".into(), "bash".into()];
    let mut input = f.input.clone();
    input.preset = Some("worker".into());
    input.tools = None;
    input.work_mode = None;
    assert!(crate::collaboration::resolve_selection(&selected, &input).is_err());
    assert_eq!(selected.catalog.presets[0].tools, vec!["read", "bash"]);
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn absent_source_defaults_derive_from_frozen_declarations_but_explicit_domain_tools_remain_exact() {
    use varin_runtime::catalog::dispatch::{
        ChildModelSource, ChildPreset, ChildPresetDefault, ChildPresetToolsSource, ChildWorkMode,
    };
    let native = schemas();
    let get = |name: &str| {
        native
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let f = fixture::Fixture::new_parent_custom(
        0,
        get("memory"),
        get("dispatch"),
        false,
        false,
        true,
        |input, launch| {
            input.tools = Some(vec!["helper".into()]);
            launch.source = None;
            launch.tools.retain(|tool| tool.name != "wait_child");
            launch.tools.push(get("wait_child"));
        },
    );
    let mut selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    selected.catalog.native_capabilities = descriptors();
    let mut input = f.input.clone();
    for (id, member, mode) in [
        (
            "worker",
            ChildPresetDefault::Worker,
            ChildWorkMode::IsolatedWrite,
        ),
        (
            "retrieval",
            ChildPresetDefault::Retrieval,
            ChildWorkMode::ReadOnly,
        ),
    ] {
        let all: Vec<_> = selected
            .catalog
            .native_capabilities
            .iter()
            .filter(|descriptor| descriptor.default_presets.contains(&member))
            .map(|descriptor| descriptor.name.clone())
            .collect();
        let index = selected.catalog.presets.len();
        selected.catalog.presets.push(ChildPreset {
            work_focus: Vec::new(),
            external: None,
            description: None,
            avatar: None,
            id: id.into(),
            name: id.into(),
            instructions: String::new(),
            tools: all.clone(),
            tools_source: ChildPresetToolsSource::Default,
            retired_work_mode: Some(mode),
            model_source: ChildModelSource::Inherit,
            inherit_base: None,
            model: None,
            unavailable: None,
        });
        input.preset = Some(id.into());
        input.work_mode = None;
        input.tools = None;
        let (resolved, tools) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert!(!tools.is_empty());
        assert!(tools
            .iter()
            .all(|tool| selected.source_requirement(&tool.name)
                == Some(ChildSourceRequirement::None)));
        assert_eq!(
            selected.catalog.presets[index].tools, all,
            "a source projection does not mutate the configured snapshot"
        );
        assert_eq!(resolved.profile.work_mode, ChildWorkMode::Shared);
        input.tools = Some(vec!["code_retrieval".into()]);
        let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
        assert!(error.message.contains("exceed the frozen delegation"), "{error}");
        input.tools = None;
        input.work_mode = Some(ChildWorkMode::ReadOnly);
        assert!(crate::collaboration::resolve_selection(&selected, &input).is_ok());
        input.work_mode = None;
        input.tools = Some(vec!["file_read".into()]);
        let (_, tools) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert!(tools.iter().any(|tool| tool.name == "file_read"));
        input.tools = Some(if member == ChildPresetDefault::Worker {
            vec!["file_read".into(), "file_write".into(), "process_spawn".into()]
        } else {
            vec!["file_read".into(), "file_list".into()]
        });
        let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
        assert!(error.message.contains("exceed the frozen delegation"), "{error}");
        input.tools = None;
        selected.catalog.presets[index].tools_source = ChildPresetToolsSource::Explicit;
        let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
        assert!(error.message.contains("file_list"), "{error}");
        assert!(!error.message.contains("file_read"), "attachment reads do not require a Source: {error}");
        if member == ChildPresetDefault::Worker {
            input.tools = Some(vec!["file_write".into()]);
            let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
            assert!(error.message.contains("require a file source: file_write"), "{error}");
            input.tools = None;
        }
    }
    input.preset = None;
    input.tools = Some(vec!["helper".into()]);
    input.work_mode = Some(ChildWorkMode::ReadOnly);
    let (_, tools) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
    assert_eq!(tools, with_disclosure(vec![selected.extension_bindings[0].tool.clone()]));
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_tree_cancel_reaches_original_binding_token_before_physical_notification() {
    let directory = schemas();
    let read = directory.iter().find(|tool| tool.name == "file_read").unwrap().clone();
    let dispatch = directory.iter().find(|tool| tool.name == "dispatch").unwrap().clone();
    let mut fixture = fixture::Fixture::new_with_schemas(0, read, dispatch);
    let snapshot: RequestSnapshot = serde_json::from_value(
        fixture.db.capture_model_step_read("parent-request").unwrap().load_request().unwrap(),
    ).unwrap();
    let mut binding = snapshot.view.binding;
    let run = fixture.context.run_id.clone();
    let epoch = fixture.db.epoch();
    let thread = fixture.db.run(&run).unwrap().thread_id;
    // This is ControlCommands' real durable-first interval: the tree command is
    // committed, but cancel_control has not notified the original worker yet.
    fixture.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
        thread_id: thread,
    }).unwrap();
    let cancel = CancellationToken::default();
    assert!(!cancel.is_cancelled());
    let root = fixture.root.clone();
    let catalog = std::sync::Arc::new(std::sync::Mutex::new(fixture.db));
    let hook = BindingPreparation {
        inner: std::sync::Arc::new(NoopContextPreparation),
        catalog: catalog.clone(),
    };
    let result = hook.prepare_binding(&run, epoch, &mut binding, &cancel);
    assert!(result.is_err(), "cancelled Run cannot publish a new binding");
    assert!(catalog.lock().unwrap().run(&run).unwrap().cancel_requested);
    assert!(cancel.is_cancelled(), "binding rejection must propagate the original durable cancellation before Engine handles its error");
    drop(hook);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn lazy_file_child_admission_is_explicit_and_belongs_to_its_original_dispatch() {
    use varin_runtime::catalog::dispatch::ChildWorkMode;
    use varin_runtime::catalog::launches::{LazyWorkLocation, SourceResourceOwner};
    let native = schemas();
    let get = |name: &str| native.iter().find(|t| t.name == name).unwrap().clone();
    let location = LazyWorkLocation { resource_owner: SourceResourceOwner::Local,
        path: "/remembered".into(), workspace_id: None };
    let mut f = fixture::Fixture::new_parent_custom(0, get("file_read"), get("dispatch"),
        false, false, false, |input, launch| {
            input.tools = Some(vec!["file_read".into()]);
            input.work_mode = Some(ChildWorkMode::ReadOnly);
            launch.source = None;
            launch.lazy_work_location = Some(location.clone());
        });
    let frozen = f.db.capture_child_dispatch_invocation(&f.context).unwrap().load().unwrap();
    assert_eq!(frozen.frozen.lazy_work_location.as_ref(), Some(&location));
    assert_eq!(frozen.resolve(&f.input).unwrap().lazy_work_location.as_ref(), Some(&location));

    let mut unselected = f.input.clone();
    unselected.work_mode = None;
    assert!(frozen.resolve(&unselected).unwrap().lazy_work_location.is_none());
    unselected.work_mode = Some(ChildWorkMode::IsolatedWrite);
    assert!(frozen.resolve(&unselected).unwrap().lazy_work_location.is_none());

    let mut launch = f.launch.clone();
    launch.source = None;
    let expected = frozen.resolve(&f.input).unwrap();
    launch.tools = expected.profile.tools.iter().map(|name| {
        if name == "file_read" { crate::work_locations::child_schema(get(name)) }
        else { get(name) }
    }).collect();
    let mut wrong = location.clone();
    wrong.path = "/foreign".into();
    launch.lazy_work_location = Some(wrong.clone());
    assert!(f.db.prepare_child_launch(&f.context.run_id, launch.clone(), expected).unwrap().load().is_err());
    launch.lazy_work_location = Some(location.clone());
    let mut wrong_tool = launch.clone();
    wrong_tool.tools.retain(|t| t.name != "file_read");
    wrong_tool.tools.push(crate::work_locations::child_schema(get("file_write")));
    assert!(f.db.prepare_child_launch(&f.context.run_id, wrong_tool, frozen.resolve(&f.input).unwrap()).unwrap().load().is_err());
    let wrong_context = ToolExecutionContext { operation_id: "foreign-dispatch".into(), ..f.context.clone() };
    let wrong_attempt = f.db.prepare_child_launch(&f.context.run_id, launch.clone(), frozen.resolve(&f.input).unwrap()).unwrap().load().unwrap();
    assert!(f.db.prepare_child_admission(&wrong_context, f.input.clone(), None, wrong_attempt)
        .and_then(|prepared| prepared.load()).is_err());
    let child_launch = f.db.prepare_child_launch(&f.context.run_id, launch, frozen.resolve(&f.input).unwrap()).unwrap().load().unwrap();
    let child = f.db.prepare_child_admission(&f.context, f.input.clone(), None, child_launch).unwrap().load().unwrap();
    let child = f.db.accept_child_references(child).unwrap();
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: "lazy-context".into(), branch_id: child.child_branch_id.clone(), through_id: None,
        expected_revision: 0, summary: String::new(), effective_system_prompt: "Child".into(),
        instruction_sources: vec![], memory_checkpoint: None,
    };
    let basis = serde_json::from_value(serde_json::json!({
        "mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"lazy-child","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"system","content":"Child"}],"instructionSources":[]
    })).unwrap();
    let prepared = f.db.capture_child_preparation(&child.operation_id, None, proposal, basis).unwrap().load().unwrap();
    let admitted = f.db.admit_child(prepared).unwrap();
    let run = &admitted.receipt.as_ref().unwrap().run_id;
    assert!(f.db.require_lazy_child_launch(run, &location).is_ok());
    assert!(f.db.require_lazy_child_launch(run, &wrong).is_err());
    assert!(f.db.require_lazy_child_launch(&f.context.run_id, &location).is_err());
    assert!(admitted.launch.source.is_none());
    assert!(admitted.launch.tools_ref.is_object());
    let selected = f.db.launch_intent(run).unwrap().unwrap().selection;
    assert!(selected.tools.iter().all(|tool| !crate::work_locations::is_control(&tool.name)));
    let reader = selected.tools.iter().find(|t|t.name=="file_read").unwrap();
    assert_eq!(reader.version, "4");
    assert!(reader.schema["oneOf"].as_array().unwrap().iter().all(|variant|variant["properties"].get("location").is_none()));
    let root = f.root.clone();
    drop(frozen); drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
