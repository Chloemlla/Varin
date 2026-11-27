use super::*;
use serde::Deserialize;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxResult {
    pub status: u16,
    pub body: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxReconcile {
    inbox_id: String,
    principal_id: String,
    key: String,
    thread_id: String,
    branch_id: String,
    method: String,
    result: Option<InboxResult>,
    draft: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxRejected {
    pub principal_id: String,
    pub thread_id: String,
    pub branch_id: String,
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS supervisor_inputs(
            id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL, branch_id TEXT NOT NULL,
            command_key TEXT NOT NULL, method TEXT NOT NULL, preexisting INTEGER NOT NULL, result TEXT, rejected TEXT
         );
         CREATE INDEX IF NOT EXISTS supervisor_input_rejections ON supervisor_inputs(principal_id,thread_id,branch_id)
           WHERE rejected IS NOT NULL;
         CREATE INDEX IF NOT EXISTS supervisor_input_expired ON supervisor_inputs(command_key,thread_id,branch_id)
           WHERE json_extract(result,'$.body.code')='inbox-replay-expired';"
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxDismiss {
    inbox_id: String,
    principal_id: String,
    thread_id: String,
    branch_id: String,
}

pub(super) fn require_unexpired(
    tx: &Transaction<'_>,
    key: &str,
    thread: &str,
    branch: &str,
) -> Result<()> {
    let expired = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM supervisor_inputs WHERE command_key=?1 AND thread_id=?2 AND branch_id=?3
         AND json_extract(result,'$.body.code')='inbox-replay-expired')",
        params![key, thread, branch],
        |row| row.get::<_, bool>(0),
    )?;
    if expired {
        return Err(RuntimeError::Conflict("supervisor inbox input expired".into()));
    }
    Ok(())
}

impl Catalog {
    pub fn reconcile_inbox_input(&mut self, input: InboxReconcile) -> Result<Value> {
        if !matches!(input.method.as_str(), "submit" | "enqueue") {
            return Err(RuntimeError::Invalid(
                "unknown supervisor input method".into(),
            ));
        }
        let tx = self.db.transaction()?;
        // A reservation precedes the original command. It lets a replay recover
        // that receipt without consulting a model or attachment that has changed.
        // A key already used before reservation must use normal intent comparison.
        tx.execute(
            "INSERT INTO supervisor_inputs(id,principal_id,thread_id,branch_id,command_key,method,preexisting)
             VALUES(?1,?2,?3,?4,?5,?6,EXISTS(SELECT 1 FROM commands WHERE id=?5)) ON CONFLICT(id) DO NOTHING",
            params![input.inbox_id, input.principal_id, input.thread_id, input.branch_id, input.key, input.method],
        )?;
        let current: Option<(bool, Option<String>)> = tx.query_row(
            "SELECT preexisting,result FROM supervisor_inputs
             WHERE id=?1 AND principal_id=?2 AND thread_id=?3 AND branch_id=?4 AND command_key=?5 AND method=?6",
            params![input.inbox_id, input.principal_id, input.thread_id, input.branch_id, input.key, input.method],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((preexisting, recorded)) = current else {
            return Err(RuntimeError::Conflict(
                "supervisor input identity changed".into(),
            ));
        };
        if let Some(recorded) = recorded {
            tx.commit()?;
            self.confirm_ingress_durable()?;
            return Ok(json!({"result":serde_json::from_str::<Value>(&recorded)?}));
        }
        let mut settled = input.result;
        if !preexisting {
            let receipt: Option<String> = tx
                .query_row(
                    "SELECT receipt FROM commands WHERE id=?1",
                    [&input.key],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(receipt) = receipt {
                let body: Value = serde_json::from_str(&receipt)?;
                let expected = if input.method == "submit" {
                    body.get("thread_id").and_then(Value::as_str) == Some(input.thread_id.as_str())
                        && body.get("branch_id").and_then(Value::as_str)
                            == Some(input.branch_id.as_str())
                } else if let Some(id) = body.get("input_id").and_then(Value::as_str) {
                    tx.query_row(
                        "SELECT branch_id FROM input_queue WHERE id=?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .as_deref()
                        == Some(input.branch_id.as_str())
                } else {
                    false
                };
                if expected {
                    settled = Some(InboxResult { status: 200, body });
                }
            }
        }
        let mut needs_ack = false;
        if let Some(ref outcome) = settled {
            let rejected = if outcome.status >= 400 {
                Some(encode(
                    &json!({"inboxId":input.inbox_id,"key":input.key,"draft":input.draft,
                    "code":outcome.body.get("code"),"status":outcome.status}),
                )?)
            } else {
                None
            };
            tx.execute(
                "UPDATE supervisor_inputs SET result=?2,rejected=?3 WHERE id=?1",
                params![input.inbox_id, encode(outcome)?, rejected],
            )?;
            needs_ack = true;
        }
        tx.commit()?;
        // The reservation also has to survive loss of the process before the
        // coordinator sends the ordinary admission command.
        self.confirm_ingress_durable()?;
        Ok(if needs_ack {
            json!({"result":settled})
        } else {
            json!({})
        })
    }

    pub fn dismiss_inbox_input(&mut self, input: InboxDismiss) -> Result<Value> {
        // Keep the settlement for lost-ack reconciliation and release the draft.
        self.db.execute(
            "UPDATE supervisor_inputs SET rejected=NULL
             WHERE id=?1 AND principal_id=?2 AND thread_id=?3 AND branch_id=?4 AND rejected IS NOT NULL",
            params![input.inbox_id, input.principal_id, input.thread_id, input.branch_id],
        )?;
        Ok(json!({"ok":true}))
    }

    pub fn rejected_inbox_inputs(&self, input: InboxRejected) -> Result<Value> {
        let mut statement = self.db.prepare(
            "SELECT rejected FROM supervisor_inputs
             WHERE principal_id=?1 AND thread_id=?2 AND branch_id=?3 AND rejected IS NOT NULL ORDER BY rowid DESC"
        )?;
        let rows = statement.query_map(
            params![input.principal_id, input.thread_id, input.branch_id],
            |row| row.get::<_, String>(0),
        )?;
        let mut values = Vec::new();
        for row in rows {
            values.push(serde_json::from_str::<Value>(&row?)?);
        }
        Ok(json!(values))
    }
}
