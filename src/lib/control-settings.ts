// Per-workspace execution-control settings (Ф5 5.B9), stored in
// Workspace.settings.control. Missing keys fall back to the defaults below, so an
// empty `{}` settings object behaves sensibly.

import { z } from 'zod';

export const ControlSettingsSchema = z.object({
  /** Remind assignees this many days before the deadline (0 = on the day). */
  reminder_days: z.array(z.number().int().min(0).max(30)).max(5),
  /** Local hour (workspace time zone) at which reminders go out. */
  reminder_hour: z.number().int().min(0).max(23),
  /** Escalate to the department head after this many days overdue (0 = never). */
  escalation_days: z.number().int().min(0).max(60),
  /** Handing in for review requires a written report. */
  require_report: z.boolean(),
});

export type ControlSettings = z.infer<typeof ControlSettingsSchema>;

export const DEFAULT_CONTROL_SETTINGS: ControlSettings = {
  reminder_days: [3, 1, 0],
  reminder_hour: 9,
  escalation_days: 3,
  require_report: false,
};

/** Partial update accepted by `PATCH /workspaces/:slug { settings: { control } }`. */
export const ControlSettingsPatchSchema = ControlSettingsSchema.partial();

/** Effective settings: stored values over defaults (invalid stored values are ignored). */
export function controlSettings(settings: unknown): ControlSettings {
  const stored =
    settings && typeof settings === 'object' && 'control' in settings
      ? (settings as { control: unknown }).control
      : {};
  const parsed = ControlSettingsPatchSchema.safeParse(stored);
  return { ...DEFAULT_CONTROL_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}
