import type { SessionsActivityOutput } from "@miao/client"

export function timerDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Countdowns are observations of live schedules, never inferred from prose. */
export function sessionTimerRows(activity: SessionsActivityOutput, now: number) {
  const pending =
    activity.pendingNotifications > 0
      ? [
          {
            id: "pending",
            color: "warning" as const,
            text: `${activity.pendingNotifications} notification(s) queued · waiting for session boundary`,
          },
        ]
      : []
  const schedules = activity.schedules.map((schedule) => ({
    id: schedule.id,
    color: "textMuted" as const,
    text: `${schedule.recurring ? "Next check" : "Wakeup"} ${schedule.nextAt > now ? `in ${timerDuration(schedule.nextAt - now)}` : "due · waiting for scheduler"} · waited ${timerDuration(now - schedule.createdAt)}`,
  }))
  const jobs = activity.jobs
    .filter((job) => job.status === "running" || (job.completedAt !== undefined && now - job.completedAt < 30_000))
    .toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt)
    .map((job) => ({
      id: job.id,
      color:
        job.status === "running"
          ? ("textMuted" as const)
          : job.status === "completed"
            ? ("success" as const)
            : ("warning" as const),
      text: `${job.status === "running" ? "Running" : job.status === "completed" ? "Finished" : job.status === "cancelled" ? "Cancelled" : "Failed"} ${timerDuration((job.completedAt ?? now) - job.startedAt)} · ${(job.title ?? job.id).split("\n")[0].replace(/\s+/g, " ").slice(0, 70)}`,
    }))
  const unknown = activity.jobs.some((job) => job.status === "error" && job.completedAt === undefined)
    ? [
        {
          id: "unknown",
          color: "warning" as const,
          text: "Background job untracked · outcome unknown; it was not restarted",
        },
      ]
    : []
  return [...pending, ...schedules, ...jobs, ...unknown]
}
