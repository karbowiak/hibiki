import { create } from "zustand"
import type { Activity } from "./model"

interface Job {
  activity: Activity
  current(): boolean
  token: symbol
}
export const useActivityStore = create<{ jobs: Record<string, Job> }>(() => ({
  jobs: {},
}))

/** Transient work only; durable sync and download receipts remain in their own stores. */
export function beginActivity(activity: Activity, current: () => boolean) {
  const token = Symbol(activity.id)
  useActivityStore.setState((state) => ({
    jobs: { ...state.jobs, [activity.id]: { activity, current, token } },
  }))
  return {
    update(change: Partial<Omit<Activity, "id">>) {
      if (!current()) return
      useActivityStore.setState((state) => {
        const job = state.jobs[activity.id]
        return job?.token === token
          ? {
              jobs: {
                ...state.jobs,
                [activity.id]: {
                  ...job,
                  activity: { ...job.activity, ...change },
                },
              },
            }
          : state
      })
    },
    finish() {
      useActivityStore.setState((state) => {
        if (state.jobs[activity.id]?.token !== token) return state
        const jobs = { ...state.jobs }
        delete jobs[activity.id]
        return { jobs }
      })
    },
  }
}
