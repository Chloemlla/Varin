import fs from 'node:fs';
import path from 'node:path';

const ownedGeneration = /^\.application-host-(?:dev|staging|types-staging|types-backup)-([1-9]\d*)$/;

function hasExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM, PID reuse or an unsupported liveness probe are not evidence of
    // an exited owner. Leaving a stale generation is safer than removing it.
    return error?.code === 'ESRCH';
  }
}

export function reclaimAbandonedHostGenerations(webRoot) {
  let reclaimed = 0;
  for (const entry of fs.readdirSync(webRoot, { withFileTypes: true })) {
    const pid = Number(ownedGeneration.exec(entry.name)?.[1]);
    if (!entry.isDirectory() || !hasExited(pid)) continue;
    const target = path.join(webRoot, entry.name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      reclaimed++;
    } catch {
      // Indexers and Windows handles may keep abandoned files busy briefly.
      // A later build can retry without disrupting the current build.
    }
  }
  return reclaimed;
}
