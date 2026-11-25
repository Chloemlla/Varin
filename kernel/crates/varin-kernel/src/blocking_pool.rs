use std::{io, sync::Arc, thread};
use tokio::runtime::{Builder, Runtime};

/// File/codec work runs independently of the protocol actor. Tokio creates blocking
/// workers on demand and releases their stacks after its idle keep-alive.
pub(crate) struct BlockingPool {
    owner: Arc<Owner>,
}

struct Owner {
    runtime: Option<Runtime>,
}

impl BlockingPool {
    pub(crate) fn new(name: &'static str) -> io::Result<Self> {
        Self::with_parallelism(name, thread::available_parallelism().map_or(1, |n| n.get()))
    }

    fn with_parallelism(name: &'static str, parallelism: usize) -> io::Result<Self> {
        let runtime = Builder::new_current_thread()
            .max_blocking_threads(parallelism)
            .thread_name(name)
            .build()?;
        Ok(Self {
            owner: Arc::new(Owner { runtime: Some(runtime) }),
        })
    }

    pub(crate) fn submit(&self, work: impl FnOnce() + Send + 'static) {
        let owner = self.owner.clone();
        self.owner.runtime.as_ref().expect("live pool").spawn_blocking(move || {
            // An accepted job, including a queued receipt, outlives its submitting actor.
            let _owner = owner;
            work();
        });
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        // The last job can release the runtime on one of its own blocking threads.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn accepted_jobs_finish_after_the_submitter_exits() {
        let pool = BlockingPool::with_parallelism("test-blocking", 1).unwrap();
        let (release, wait) = mpsc::channel();
        let (finished, receipt) = mpsc::channel();
        pool.submit(move || wait.recv().unwrap());
        pool.submit(move || finished.send(()).unwrap());
        drop(pool);
        release.send(()).unwrap();
        receipt.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
