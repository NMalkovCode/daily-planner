import { ReactNode, useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { api, BackupsInfo, DbInfo } from "../lib/api";
import { parseDate } from "../lib/dates";
import { usePlanner } from "../lib/planner";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Setting({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="setting-title">{title}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

const LEADS = [
  ["off", "Don't remind me"],
  ["0", "When it starts"],
  ["5", "5 minutes before"],
  ["10", "10 minutes before"],
  ["15", "15 minutes before"],
  ["30", "30 minutes before"],
  ["60", "1 hour before"],
];

/** Toggle plus a time for the evening/morning reminders; "off" when switched off. */
function TimedSetting(props: { title: string; hint: string; value: string; fallback: string; onChange: (v: string) => void }) {
  const on = props.value !== "off";
  const [time, setTime] = useState(on ? props.value : props.fallback);
  return (
    <Setting title={props.title} hint={props.hint}>
      <div className="setting-controls">
        <input
          type="time"
          className="input"
          value={time}
          disabled={!on}
          aria-label={`${props.title} time`}
          onChange={(e) => {
            setTime(e.target.value);
            if (e.target.value) props.onChange(e.target.value);
          }}
        />
        <Toggle label={props.title} checked={on} onChange={(v) => props.onChange(v ? time : "off")} />
      </div>
    </Setting>
  );
}

function ReminderSettings() {
  const { notify } = usePlanner();
  const [s, setS] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.settings().then(setS);
  }, []);
  if (!s) return null;

  const set = async (key: string, value: string) => {
    await api.setSetting(key, value);
    setS((prev) => ({ ...prev, [key]: value }));
  };
  const enabled = s["reminders.enabled"] !== "false";

  return (
    <section className="panel">
      <h2 className="settings-section">Reminders</h2>
      <Setting title="Show reminders" hint="Windows notifications from Daily Planner while it’s running (including in the tray).">
        <Toggle label="Show reminders" checked={enabled} onChange={(v) => set("reminders.enabled", String(v))} />
      </Setting>
      <div className={enabled ? "" : "settings-disabled"}>
        <Setting title="Before a task starts" hint="For tasks with a start time.">
          <select
            className="input select"
            value={s["reminders.startLead"] ?? "10"}
            onChange={(e) => set("reminders.startLead", e.target.value)}
            aria-label="Before a task starts"
          >
            {LEADS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Setting>
        <Setting
          title="Deadlines"
          hint="The day before and on the day. Deadlines with a time also get a reminder 1 hour before."
        >
          <Toggle label="Deadline reminders" checked={s["reminders.deadlines"] !== "false"} onChange={(v) => set("reminders.deadlines", String(v))} />
        </Setting>
        <TimedSetting
          title="Evening preparation reminder"
          hint="Lists what needs preparing for tomorrow (and longer preparations that have started)."
          value={s["reminders.prepTime"] ?? "19:00"}
          fallback="19:00"
          onChange={(v) => set("reminders.prepTime", v)}
        />
        <TimedSetting
          title="Morning summary"
          hint="Today’s tasks, deadlines and preparation at a glance. Also the time for date-only deadline reminders."
          value={s["reminders.morningTime"] ?? "08:00"}
          fallback="08:00"
          onChange={(v) => set("reminders.morningTime", v)}
        />
        <Setting title="Test" hint="If nothing appears, check that notifications are allowed in Windows Settings → System → Notifications.">
          <button
            className="btn small"
            onClick={() => api.testNotification().then(() => notify("Test notification sent")).catch((e) => notify(String(e)))}
          >
            Send a test notification
          </button>
        </Setting>
      </div>
    </section>
  );
}

function Choice<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={props.value === v} className={props.value === v ? "on" : ""} onClick={() => props.onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function AppearanceSettings() {
  const { refresh } = usePlanner();
  const [theme, setTheme] = useState("system");
  const [weekStart, setWeekStart] = useState("monday");

  useEffect(() => {
    api.settings().then((s) => {
      setTheme(s.theme ?? "system");
      setWeekStart(s.weekStart ?? "monday");
    });
  }, []);

  const save = async (key: string, value: string, set: (v: string) => void) => {
    set(value);
    await api.setSetting(key, value);
    refresh(); // applies it in this window and the tray pop-up
  };

  return (
    <section className="panel">
      <h2 className="settings-section">Appearance</h2>
      <Setting title="Theme" hint="“System” follows your Windows light or dark mode.">
        <Choice
          label="Theme"
          value={theme}
          options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]}
          onChange={(v) => save("theme", v, setTheme)}
        />
      </Setting>
      <Setting title="Week starts on" hint="For the calendar’s month and week views.">
        <Choice
          label="Week starts on"
          value={weekStart}
          options={[["monday", "Monday"], ["sunday", "Sunday"]]}
          onChange={(v) => save("weekStart", v, setWeekStart)}
        />
      </Setting>
    </section>
  );
}

function DataSettings({ info }: { info: DbInfo | null }) {
  const { notify, refresh, today } = usePlanner();
  const [backups, setBackups] = useState<BackupsInfo | null>(null);
  const loadBackups = () => api.backupsInfo().then(setBackups);
  useEffect(() => {
    loadBackups();
  }, []);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      notify(String(e));
    }
  };

  const exportBackup = () =>
    run(async () => {
      const path = await save({
        title: "Save a backup of your planner",
        defaultPath: `daily-planner-backup-${today}.json`,
        filters: [{ name: "Daily Planner backup", extensions: ["json"] }],
      });
      if (!path) return;
      await api.exportBackup(path);
      notify("Backup saved");
    });

  const restore = () =>
    run(async () => {
      const path = await open({
        title: "Restore from a backup",
        defaultPath: backups?.folder,
        filters: [{ name: "Daily Planner backup", extensions: ["json", "db"] }],
      });
      if (!path || Array.isArray(path)) return;
      const sure = await ask(
        "This replaces all your current tasks, habits, notes and settings with the ones in the backup.\n\nA copy of your current data is saved in the backups folder first.",
        { title: "Restore this backup?", kind: "warning", okLabel: "Restore", cancelLabel: "Cancel" },
      );
      if (!sure) return;
      const r = await api.restoreBackup(path);
      notify(`Restored ${r.tasks} tasks, ${r.habits} habits and ${r.notes} notes`);
      refresh();
      loadBackups();
    });

  const exportCalendar = () =>
    run(async () => {
      const path = await save({
        title: "Export to a calendar file",
        defaultPath: "daily-planner.ics",
        filters: [{ name: "Calendar file", extensions: ["ics"] }],
      });
      if (!path) return;
      const n = await api.exportCalendar(path);
      notify(`Exported ${n} events`);
    });

  const latest = backups?.latest
    ? parseDate(backups.latest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;

  return (
    <section className="panel">
      <h2 className="settings-section">Data</h2>
      <Setting
        title="Automatic backups"
        hint={latest ? `Every day, keeping the last 14. Latest: ${latest} (${backups!.count} kept).` : "Every day, keeping the last 14."}
      >
        <button className="btn small" onClick={() => run(api.openBackupsFolder)}>Open folder</button>
      </Setting>
      <Setting title="Backup file" hint="Save everything to one file, e.g. to move to another PC or keep somewhere safe.">
        <div className="setting-controls">
          <button className="btn small" onClick={exportBackup}>Save backup…</button>
          <button className="btn small" onClick={restore}>Restore…</button>
        </div>
      </Setting>
      <Setting title="Export to a calendar" hint="An .ics file of your dated tasks for Google Calendar, Outlook or Apple Calendar.">
        <button className="btn small" onClick={exportCalendar}>Export .ics…</button>
      </Setting>
      <Setting title="Database file" hint={<code>{info?.path}</code>}>
        <span />
      </Setting>
    </section>
  );
}

export function SettingsView() {
  const { notify } = usePlanner();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [closeToTray, setCloseToTray] = useState(true);
  const [info, setInfo] = useState<DbInfo | null>(null);

  useEffect(() => {
    api.autostart().then(setAutostart).catch(() => setAutostart(false));
    api.setting("closeToTray").then((v) => setCloseToTray(v !== "false"));
    api.dbInfo().then(setInfo);
  }, []);

  async function changeAutostart(on: boolean) {
    try {
      await api.setAutostart(on);
      setAutostart(on);
      notify(on ? "Daily Planner will start with Windows" : "Daily Planner won't start with Windows");
    } catch (e) {
      notify(`Couldn't change this: ${e}`);
      setAutostart(await api.autostart().catch(() => false));
    }
  }

  async function changeCloseToTray(on: boolean) {
    await api.setSetting("closeToTray", String(on));
    setCloseToTray(on);
  }

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="panel">
        <h2 className="settings-section">Startup and tray</h2>
        <Setting
          title="Start with Windows"
          hint="Opens quietly in the tray when you sign in, so reminders and the summary are always ready."
        >
          {autostart != null && <Toggle label="Start with Windows" checked={autostart} onChange={changeAutostart} />}
        </Setting>
        <Setting
          title="Keep running in the tray when closed"
          hint={
            <>
              Closing the window hides it instead of quitting. Click the Daily Planner icon under the{" "}
              <b>^</b> arrow on the taskbar for today’s summary, or right-click it to quit.
            </>
          }
        >
          <Toggle label="Keep running in the tray when closed" checked={closeToTray} onChange={changeCloseToTray} />
        </Setting>
      </section>

      <AppearanceSettings />

      <ReminderSettings />

      <DataSettings info={info} />
    </div>
  );
}
