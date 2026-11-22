//! Explicit history-head navigation. Original Runs and effects remain immutable facts.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NavigationCommand {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub expected_head_id: Option<String>,
    pub target_head_id: Option<String>,
    /// Only the exact original receipt may authorize returning to a removed descendant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserved_plan: Option<plan::PlanForkCapture>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationReceipt {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub previous_head_id: Option<String>,
    pub head_id: Option<String>,
    pub already_applied: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationSelection {
    pub expected_head_id: Option<String>,
    pub target_head_id: Option<String>,
    pub removed_entry_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_entry: Option<history_views::HistoryReference>,
}
pub struct NavigationRead {
    thread: String,
    head: Option<String>,
    entry: String,
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct NavigationPreparation {
    command: NavigationCommand,
    epoch: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    checkpoint: Option<context::CheckpointRead>,
    previous: Option<NavigationReceipt>,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedNavigation {
    command: NavigationCommand,
    epoch: u64,
    checkpoint: Option<(context::CheckpointMetadata, Value)>,
    preserved_checkpoint: Option<(context::CheckpointMetadata, Value)>,
    previous: Option<NavigationReceipt>,
    _publication: crate::content::ContentPublication,
}
fn command_key(branch: &str, key: &str) -> String {
    format!("navigation:{}:{branch}:{key}", branch.len())
}
fn preserved_branch(command: &NavigationCommand) -> String {
    format!("preserved:{}", command_key(&command.branch_id, &command.key))
}
fn intent(command: &NavigationCommand) -> Result<Value> {
    let mut value = serde_json::to_value(command)?;
    // The plan capture is derived during preparation. Retries retain the user
    // command identity even after the source plan/context has advanced.
    value.as_object_mut().unwrap().remove("preservedPlan");
    Ok(value)
}
fn receipt(db: &Connection, branch: &str, key: &str) -> Result<Option<(Value, NavigationReceipt)>> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT intent,receipt FROM commands WHERE id=?1",
            [command_key(branch, key)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(intent, result)| {
        Ok((
            serde_json::from_str(&intent)?,
            serde_json::from_str(&result)?,
        ))
    })
    .transpose()
}
fn existing(db: &Connection, command: &NavigationCommand) -> Result<Option<NavigationReceipt>> {
    if let Some((original, mut result)) = receipt(db, &command.branch_id, &command.key)? {
        if original != crate::content::ContentStore::reference(&intent(command)?)? {
            return Err(RuntimeError::Conflict(
                "navigation key has different input".into(),
            ));
        }
        // A subsequent legal head change does not erase the original successful operation.
        result.already_applied = true;
        return Ok(Some(result));
    }
    Ok(None)
}
pub(super) fn idle(db: &Connection, thread: &str, branch: &str) -> Result<Option<String>> {
    context_jobs::require_regular_branch(db, branch)?;
    let (owner, head, active): (String, Option<String>, Option<String>) = db
        .query_row(
            "SELECT thread_id,head,active_run FROM branches WHERE id=?1",
            [branch],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| RuntimeError::NotFound(branch.into()))?;
    if owner != thread {
        return Err(RuntimeError::Conflict(
            "navigation branch belongs to another Thread".into(),
        ));
    }
    if active.is_some() {
        return Err(RuntimeError::Conflict(
            "stop the branch's foreground Run before navigating its history".into(),
        ));
    }
    let activating: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND state='queued' AND activation='activating')", [branch], |r| r.get(0))?;
    if activating {
        return Err(RuntimeError::Conflict(
            "a branch input is being committed".into(),
        ));
    }
    Ok(head)
}
fn removed_entries(
    db: &Connection,
    thread: &str,
    mut head: Option<String>,
    stop: Option<&str>,
) -> Result<Vec<String>> {
    let mut parent = db.prepare("SELECT parent FROM history WHERE id=?1 AND thread_id=?2")?;
    let mut removed = Vec::new();
    while head.as_deref() != stop {
        let id = head.ok_or_else(|| {
            RuntimeError::Conflict("navigation target is not on the selected ancestry".into())
        })?;
        head = parent.query_row(params![id, thread], |row| row.get(0))?;
        removed.push(id);
    }
    Ok(removed)
}
/// A tool batch starts in one model response. Its outputs are appended together
/// after admitting the request; only this exchange can straddle the chosen cut.
/// The catalog already records call ids on assistant entries and writes tool
/// results under the original request/call tuple, including on older databases.
fn validate_cut(
    db: &Connection,
    content: &crate::content::ContentStore,
    thread: &str,
    head: Option<&str>,
) -> Result<()> {
    use crate::execution::{HistoryPairing, HistoryPart, model_request_from_history_id};
    let mut cursor = head.map(str::to_owned);
    let mut request = None;
    let mut tail = Vec::new();
    while let Some(id) = cursor {
        if let Some(request_id) = request.as_deref() {
            if model_request_from_history_id(&id) != Some(request_id) {
                break;
            }
        }
        let item: HistoryItem = record(db, "history", &id)?;
        if item.thread_id != thread {
            return Err(RuntimeError::Conflict("history owner changed".into()));
        }
        if item.source == HistorySource::Assistant {
            if let Some(request_id) = model_request_from_history_id(&id) {
                request = Some(request_id.to_owned());
            }
        }
        cursor = item.parent.clone();
        tail.push(item);
    }
    let result_prefix = request.as_ref().map(|id| format!("{id}:result:"));
    let mut pairing = HistoryPairing::default();
    let invalid = |err: crate::execution::ExecutionError| RuntimeError::Invalid(err.to_string());
    for item in tail.into_iter().rev() {
        let result_id = result_prefix
            .as_deref()
            .and_then(|prefix| item.id.strip_prefix(prefix));
        let part = match (item.source, result_id) {
            (HistorySource::User, _) => HistoryPart::Other,
            (HistorySource::Assistant, _)
                if model_request_from_history_id(&item.id).is_some()
                    && item.content.get("history_text").is_some() =>
            {
                item.content["history_call_id"]
                    .as_str()
                    .map_or(HistoryPart::Assistant, HistoryPart::Call)
            }
            (HistorySource::Tool, Some(call_id)) => HistoryPart::Result(call_id),
            _ => {
                let item = content.load_stored_history_item(item, &|| false)?;
                if item.source == HistorySource::Environment
                    && item.content["kind"] == "calendar_input"
                {
                    pairing.observe(HistoryPart::Other).map_err(invalid)?;
                } else {
                    // Stored media holders are sufficient; pairing never needs their bytes.
                    let original: crate::execution::ConversationItem<Value> =
                        serde_json::from_value(item.content)?;
                    pairing
                        .observe(HistoryPart::from_content(
                            &original.content,
                            &original.provenance,
                        ))
                        .map_err(invalid)?;
                }
                continue;
            }
        };
        pairing.observe(part).map_err(invalid)?;
    }
    pairing.finish().map_err(invalid)
}
impl Catalog {
    pub fn capture_navigation(
        &self,
        thread: &str,
        branch: &str,
        entry: &str,
    ) -> Result<NavigationRead> {
        let head = idle(&self.db, thread, branch)?;
        Ok(NavigationRead {
            thread: thread.into(),
            head,
            entry: entry.into(),
            database: self.database_path.clone(),
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn latest_navigation_receipt(
        &self,
        thread: &str,
        branch: &str,
    ) -> Result<Option<NavigationReceipt>> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        let value: Option<String> = self.db.query_row("SELECT data FROM events WHERE subject=?1 AND kind='branch.navigated' ORDER BY cursor DESC LIMIT 1", [branch], |row| row.get(0)).optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn navigation_receipt(
        &self,
        thread: &str,
        branch: &str,
        key: &str,
    ) -> Result<Option<NavigationReceipt>> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        Ok(receipt(&self.db, branch, key)?.map(|(_, mut value)| {
            value.already_applied = true;
            value
        }))
    }
    pub fn prepare_navigation(&self, command: NavigationCommand) -> Result<NavigationPreparation> {
        if command.key.is_empty() {
            return Err(RuntimeError::Invalid("navigation key is required".into()));
        }
        if self.branch_thread_id(&command.branch_id)? != command.thread_id {
            return Err(RuntimeError::Conflict(
                "navigation branch belongs to another Thread".into(),
            ));
        }
        let previous = existing(&self.db, &command)?;
        if let Some(capture) = &command.preserved_plan {
            let source = self.plan_view(&command.branch_id, command.expected_head_id.as_deref())?;
            if command.undo_of.is_some() || capture.source_thread_id != command.thread_id
                || capture.source_branch_id != command.branch_id
                || capture.target_branch_id != preserved_branch(&command)
                || capture.head_id != command.expected_head_id
                || capture.inherited_ref != source.inherited_ref
            {
                return Err(RuntimeError::Conflict("preserved plan differs from the navigation source".into()));
            }
        }
        if previous.is_none()
            && idle(&self.db, &command.thread_id, &command.branch_id)? != command.expected_head_id
        {
            return Err(RuntimeError::Conflict(
                "navigation expected head changed".into(),
            ));
        }
        Ok(NavigationPreparation {
            checkpoint: if previous.is_none() {
                self.capture_active_checkpoint(&command.branch_id)?
            } else {
                None
            },
            command,
            previous,
            epoch: self.epoch,
            database: self.database_path.clone(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn commit_navigation(&mut self, prepared: PreparedNavigation) -> Result<NavigationReceipt> {
        let PreparedNavigation {
            command,
            epoch,
            checkpoint,
            preserved_checkpoint,
            previous,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "navigation preparation belongs to an old owner".into(),
            ));
        }
        if let Some(result) = existing(&self.db, &command)? {
            return Ok(result);
        }
        if previous.is_some() {
            return Err(RuntimeError::Conflict(
                "navigation receipt disappeared".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if let Some(undo) = &command.undo_of {
            threads::require_branch_available(&tx, &format!("preserved:{}", command_key(&command.branch_id, undo)))?;
        }
        if idle(&tx, &command.thread_id, &command.branch_id)? != command.expected_head_id {
            return Err(RuntimeError::Conflict(
                "navigation expected head changed".into(),
            ));
        }
        // Retain the old route in the same transaction as moving its head. The
        // immutable history and content stay shared, including after more input.
        if command.undo_of.is_none() && command.expected_head_id.is_some()
            && command.expected_head_id != command.target_head_id
        {
            let target = preserved_branch(&command);
            tx.execute("INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,?3)",
                params![target, command.thread_id, command.expected_head_id])?;
            tx.execute("INSERT INTO memory_states(branch_id,body) SELECT ?1,body FROM memory_states WHERE branch_id=?2",
                params![target, command.branch_id])?;
            if let Some((metadata, reference)) = preserved_checkpoint {
                context::publish_metadata(&tx, &metadata, &reference)?;
            }
            let mut creation = json!({
                "source": command.branch_id, "head": command.expected_head_id,
                "reason": "navigation", "navigationKey": command.key,
            });
            if let Some(capture) = &command.preserved_plan { creation["planCapture"] = serde_json::to_value(capture)?; }
            event(&tx, &target, 1, "branch.created", creation)?;
            branch_workspace::inherit_at(&tx, &command.branch_id, &target, command.expected_head_id.as_deref())?;
        }
        if let Some((checkpoint, reference)) = checkpoint {
            context::publish_metadata(&tx, &checkpoint, &reference)?;
        } else {
            let has_context: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM active_contexts WHERE branch_id=?1)",
                [&command.branch_id],
                |r| r.get(0),
            )?;
            if has_context {
                return Err(RuntimeError::Conflict(
                    "navigation context changed during preparation".into(),
                ));
            }
        }
        let changed = tx.execute(
            "UPDATE branches SET head=?2 WHERE id=?1 AND head IS ?3 AND active_run IS NULL",
            params![
                command.branch_id,
                command.target_head_id,
                command.expected_head_id
            ],
        )?;
        if changed != 1 {
            return Err(RuntimeError::Conflict("navigation branch changed".into()));
        }
        if command.expected_head_id != command.target_head_id {
            branch_workspace::inherit_at(&tx, &command.branch_id, &command.branch_id, command.target_head_id.as_deref())?;
        }
        let result = NavigationReceipt {
            key: command.key.clone(),
            thread_id: command.thread_id.clone(),
            branch_id: command.branch_id.clone(),
            previous_head_id: command.expected_head_id.clone(),
            head_id: command.target_head_id.clone(),
            already_applied: false,
        };
        event(
            &tx,
            &command.branch_id,
            1,
            "branch.navigated",
            serde_json::to_value(&result)?,
        )?;
        super::bot_work_events::navigation(&tx, &result)?;
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![
                command_key(&command.branch_id, &command.key),
                encode(&crate::content::ContentStore::reference(
                    &intent(&command)?
                )?)?,
                encode(&result)?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
impl NavigationRead {
    pub fn load(self) -> Result<NavigationSelection> {
        let db = history_views::current_history_owner(&self.database, self.epoch)?;
        let mut removed = removed_entries(&db, &self.thread, self.head.clone(), Some(&self.entry))?;
        let selected: HistoryItem = record(&db, "history", &self.entry)?;
        if selected.thread_id != self.thread {
            return Err(RuntimeError::Conflict(
                "selected history owner differs".into(),
            ));
        }
        let before = selected.source == HistorySource::User;
        let target = if before {
            selected.parent.clone()
        } else {
            Some(selected.id.clone())
        };
        if before {
            removed.push(selected.id.clone());
        }
        validate_cut(&db, &self.content, &self.thread, target.as_deref())?;
        let editor_entry = before
            .then(|| history_views::HistoryReference::try_from(selected))
            .transpose()?;
        history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(NavigationSelection {
            expected_head_id: self.head,
            target_head_id: target,
            removed_entry_ids: removed,
            editor_entry,
        })
    }
}
impl NavigationPreparation {
    pub fn load(self) -> Result<PreparedNavigation> {
        let Self {
            command,
            epoch,
            database,
            content,
            checkpoint,
            previous,
            _publication,
        } = self;
        if previous.is_some() {
            return Ok(PreparedNavigation {
                command,
                epoch,
                checkpoint: None,
                preserved_checkpoint: None,
                previous,
                _publication,
            });
        }
        let db = history_views::current_history_owner(&database, epoch)?;
        content.save(&intent(&command)?)?;
        let removed = if let Some(undo) = &command.undo_of {
            let (_, original) = receipt(&db, &command.branch_id, undo)?
                .ok_or_else(|| RuntimeError::NotFound("original navigation receipt".into()))?;
            if original.head_id != command.expected_head_id
                || original.previous_head_id != command.target_head_id
            {
                return Err(RuntimeError::Conflict(
                    "undo no longer matches the original navigation".into(),
                ));
            }
            Vec::new()
        } else {
            removed_entries(
                &db,
                &command.thread_id,
                command.expected_head_id.clone(),
                command.target_head_id.as_deref(),
            )?
        };
        validate_cut(&db, &content, &command.thread_id, command.target_head_id.as_deref())?;
        let mut preserved_checkpoint = None;
        let checkpoint = checkpoint
            .map(|read| -> Result<_> {
                let mut value = read.load()?;
                if command.undo_of.is_none() && command.expected_head_id.is_some()
                    && command.expected_head_id != command.target_head_id
                {
                    let mut saved = value.clone();
                    saved.proposal.branch_id = preserved_branch(&command);
                    saved.id = format!("preserved-context:{}", command_key(&command.branch_id, &command.key));
                    saved.proposal.key = saved.id.clone();
                    saved.proposal.expected_revision = 0;
                    saved.revision = 1;
                    let reference = saved.save(&content)?;
                    preserved_checkpoint = Some((context::CheckpointMetadata::from(&saved), reference));
                }
                value.proposal.expected_revision = value.revision;
                value.revision += 1;
                value.id = format!(
                    "navigation-context:{}",
                    command_key(&command.branch_id, &command.key)
                );
                value.proposal.key = value.id.clone();
                if value
                    .proposal
                    .through_id
                    .as_ref()
                    .is_some_and(|id| removed.contains(id))
                {
                    value.proposal.through_id = None;
                    value.proposal.summary.clear();
                    value.retained = None;
                    value.resource_activations.clear();
                    if let Some(snapshot) = value.bot_memory_snapshot.take() {
                        if value.proposal.memory_checkpoint.as_deref()
                            == Some(snapshot.identity()?.as_str())
                        {
                            value.proposal.memory_checkpoint = None;
                        }
                    }
                }
                // A new context revision also fences already-prepared summarization candidates.
                let reference = value.save(&content)?;
                Ok((context::CheckpointMetadata::from(&value), reference))
            })
            .transpose()?;
        history_views::current_history_owner(&database, epoch)?;
        Ok(PreparedNavigation {
            command,
            epoch,
            checkpoint,
            preserved_checkpoint,
            previous,
            _publication,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    use std::sync::{Arc, Mutex};

    #[test]
    fn navigation_last_three_turns_reads_only_the_selected_input_and_rejects_half_a_tool_batch() {
        let root = std::env::temp_dir().join(format!("navigation-cut-{}", id()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let run = db
            .submit(&SubmitInput {
                key: "start".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"draft"}),
                configuration: json!({}),
            })
            .unwrap();
        let first: HistoryItem = record(&db.db, "history", &run.input_id).unwrap();
        let ordinary = db
            .content
            .save_history(
                &json!({"content":{"kind":"text","text":"ok"},"provenance":{"kind":"assistant"}}),
                &None,
            )
            .unwrap();
        let call = |id: &str| {
            db.content.save_history(&json!({"content":{"kind":"tool_call","call":{"call_id":id}},"provenance":{"kind":"assistant"}}), &None).unwrap()
        };
        let calls = [call("one"), call("two")];
        let results = ["one", "two"].map(|id| db.content.save_history(
            &json!({"provenance":{"kind":"tool_data","call_id":id},"content":{"kind":"tool_result","result":{"call_id":id,"completion":{"kind":"not_dispatched","reason":"cancelled"}}}}), &None).unwrap());
        let tx = db.db.transaction().unwrap();
        let mut head = first.id.clone();
        let mut append = |id: String, source: HistorySource, content: &Value| {
            let item = HistoryItem {
                id,
                source,
                parent: Some(head.clone()),
                content: content.clone(),
                ..first.clone()
            };
            tx.execute(
                "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
                params![
                    item.id,
                    item.thread_id,
                    item.parent,
                    encode(&item).unwrap(),
                    item.run_id
                ],
            )
            .unwrap();
            head = item.id;
        };
        for turn in 0..500 {
            if turn != 0 {
                append(format!("input-{turn}"), HistorySource::User, &first.content);
            }
            let request = format!("request:{turn}");
            if turn == 495 {
                for (i, reference) in calls.iter().enumerate() {
                    append(
                        crate::execution::model_history_id(&request, &i.to_string()),
                        HistorySource::Assistant,
                        reference,
                    );
                }
                for (id, reference) in ["one", "two"].into_iter().zip(&results) {
                    append(
                        format!("{request}:result:{id}"),
                        HistorySource::Tool,
                        reference,
                    );
                }
            } else {
                append(
                    crate::execution::model_history_id(&request, "answer"),
                    HistorySource::Assistant,
                    &ordinary,
                );
            }
        }
        tx.execute("UPDATE branches SET head=?1 WHERE id='main'", [&head])
            .unwrap();
        tx.commit().unwrap();
        let active = db.run(&run.run_id).unwrap();
        let active = db
            .transition_run(&active.id, db.epoch(), active.revision, RunState::Runnable)
            .unwrap();
        db.transition_run(&active.id, db.epoch(), active.revision, RunState::Completed)
            .unwrap();

        let reads = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&reads);
        db.content.set_history_read_hook(Some(Arc::new(move |id| {
            observed.lock().unwrap().push(id.to_string())
        })));
        assert!(
            db.capture_navigation("thread", "main", "request:495:result:one")
                .unwrap()
                .load()
                .is_err()
        );
        db.capture_navigation("thread", "main", "request:495:result:two")
            .unwrap()
            .load()
            .unwrap();
        let preview = db
            .capture_navigation("thread", "main", "input-497")
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(preview.removed_entry_ids.len(), 6);
        let editor = preview.editor_entry.as_ref().unwrap();
        assert_eq!(editor.id, "input-497");
        assert!(reads.lock().unwrap().is_empty());
        let draft = db.content.load_stored_history_item(record(&db.db, "history", &editor.id).unwrap(), &|| false).unwrap();
        assert_eq!(draft.content["text"], "draft");
        let command = NavigationCommand {
            key: "rewind".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head_id: preview.expected_head_id,
            target_head_id: preview.target_head_id,
            undo_of: None,
            preserved_plan: None,
        };
        let prepared = db
            .prepare_navigation(command.clone())
            .unwrap()
            .load()
            .unwrap();
        let receipt = db.commit_navigation(prepared).unwrap();
        let undo = NavigationCommand {
            key: "undo".into(),
            expected_head_id: receipt.head_id,
            target_head_id: receipt.previous_head_id,
            undo_of: Some("rewind".into()),
            ..command
        };
        let prepared = db.prepare_navigation(undo).unwrap().load().unwrap();
        assert_eq!(
            db.commit_navigation(prepared).unwrap().head_id.as_ref(),
            Some(&head)
        );
        assert_eq!(*reads.lock().unwrap(), ["input-497"]);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
