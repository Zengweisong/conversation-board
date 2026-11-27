#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_sql::{Migration, MigrationKind};

mod chat_sync;
mod codex_usage;
#[cfg(any(windows, test))]
mod codex_desktop;
mod codex_dispatch;
mod codex_projects;
mod sync_analysis;

const MIGRATION_1_SQL: &str = concat!(
    "\n",
    "            CREATE TABLE IF NOT EXISTS notes (\n",
    "                id INTEGER PRIMARY KEY AUTOINCREMENT,\n",
    "                content TEXT NOT NULL,\n",
    "                completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),\n",
    "                pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),\n",
    "                created_at TEXT NOT NULL,\n",
    "                updated_at TEXT NOT NULL,\n",
    "                completed_at TEXT NULL,\n",
    "                sort_order INTEGER NOT NULL DEFAULT 0\n",
    "            );\n",
    "            CREATE INDEX IF NOT EXISTS idx_notes_display_order\n",
    "              ON notes(completed, pinned, created_at DESC);\n",
    "            CREATE TABLE IF NOT EXISTS settings (\n",
    "                key TEXT PRIMARY KEY NOT NULL,\n",
    "                value TEXT NOT NULL,\n",
    "                updated_at TEXT NOT NULL\n",
    "            );\n",
    "        "
);

const MIGRATION_6_SQL: &str = r#"
                ALTER TABLE notes ADD COLUMN scheduled_date TEXT NULL
                  CHECK (scheduled_date IS NULL OR scheduled_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
                ALTER TABLE notes ADD COLUMN scheduled_time TEXT NULL
                  CHECK (scheduled_time IS NULL OR
                    (scheduled_time GLOB '[0-2][0-9]:[0-5][0-9]' AND scheduled_time <= '23:59'));

                -- Preserve every historical non-all-day time, including a real 09:00.
                -- Rows explicitly marked all-day migrate to a date with no item time.
                -- v4 synthesized all-day scheduled_at values at midnight. Preserve the
                -- original due_at date before applying localtime so western time zones
                -- cannot move those rows to the previous day.
                UPDATE notes
                  SET scheduled_date = substr(due_at, 1, 10)
                  WHERE COALESCE(is_all_day, 0) = 1 AND due_at IS NOT NULL
                    AND substr(due_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                    AND CAST(substr(due_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
                    AND CAST(substr(due_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) IN (1,3,5,7,8,10,12) THEN 31
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) IN (4,6,9,11) THEN 30
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) = 2 THEN CASE
                        WHEN CAST(substr(due_at, 1, 4) AS INTEGER) % 400 = 0
                          OR (CAST(substr(due_at, 1, 4) AS INTEGER) % 4 = 0
                            AND CAST(substr(due_at, 1, 4) AS INTEGER) % 100 != 0)
                        THEN 29 ELSE 28 END
                      ELSE 0 END;
                UPDATE notes
                  SET scheduled_date = strftime('%Y-%m-%d', scheduled_at, 'localtime')
                  WHERE scheduled_at IS NOT NULL AND scheduled_date IS NULL;
                UPDATE notes
                  SET scheduled_time = strftime('%H:%M', scheduled_at, 'localtime')
                  WHERE scheduled_at IS NOT NULL
                    AND repeat_series_id IS NULL
                    AND COALESCE(is_all_day, 0) = 0;
                UPDATE notes
                  SET scheduled_date = substr(due_at, 1, 10)
                  WHERE scheduled_date IS NULL AND due_at IS NOT NULL
                    AND substr(due_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                    AND CAST(substr(due_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
                    AND CAST(substr(due_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) IN (1,3,5,7,8,10,12) THEN 31
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) IN (4,6,9,11) THEN 30
                      WHEN CAST(substr(due_at, 6, 2) AS INTEGER) = 2 THEN CASE
                        WHEN CAST(substr(due_at, 1, 4) AS INTEGER) % 400 = 0
                          OR (CAST(substr(due_at, 1, 4) AS INTEGER) % 4 = 0
                            AND CAST(substr(due_at, 1, 4) AS INTEGER) % 100 != 0)
                        THEN 29 ELSE 28 END
                      ELSE 0 END;

                CREATE INDEX IF NOT EXISTS idx_notes_scheduled_date
                  ON notes(scheduled_date, scheduled_time);
            "#;

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create notes and settings tables",
            sql: MIGRATION_1_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add categories and extended todo fields",
            sql: r#"
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT '#D59D2A',
                    icon TEXT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1))
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_nocase
                  ON categories(name COLLATE NOCASE);

                INSERT OR IGNORE INTO categories (name, color, icon, sort_order, created_at, is_system) VALUES
                  ('未分类', '#8B95A5', 'inbox', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1),
                  ('工作', '#4F87C8', 'briefcase', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0),
                  ('学习', '#8B6BC2', 'book-open', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0),
                  ('生活', '#50A477', 'house', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0),
                  ('临时事项', '#D8894B', 'clock', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0);

                ALTER TABLE notes ADD COLUMN title TEXT NULL;
                ALTER TABLE notes ADD COLUMN details TEXT NULL;
                ALTER TABLE notes ADD COLUMN category_id INTEGER NULL REFERENCES categories(id) ON DELETE SET NULL;
                ALTER TABLE notes ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high'));
                ALTER TABLE notes ADD COLUMN due_at TEXT NULL;

                UPDATE notes SET title = content WHERE title IS NULL OR trim(title) = '';
                UPDATE notes SET category_id = (SELECT id FROM categories WHERE name = '未分类' LIMIT 1)
                  WHERE category_id IS NULL;
                CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category_id);
                CREATE INDEX IF NOT EXISTS idx_notes_due_at ON notes(due_at);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add independent reminders and repeat series",
            sql: r#"
                CREATE TABLE IF NOT EXISTS repeat_series (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    details TEXT NULL,
                    category_id INTEGER NULL REFERENCES categories(id) ON DELETE SET NULL,
                    priority TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low', 'normal', 'high')),
                    repeat_type TEXT NOT NULL
                      CHECK (repeat_type IN ('daily', 'weekdays', 'weekly', 'monthly', 'yearly')),
                    repeat_interval INTEGER NOT NULL DEFAULT 1 CHECK (repeat_interval > 0),
                    repeat_weekdays TEXT NULL,
                    repeat_month_day INTEGER NULL CHECK (repeat_month_day BETWEEN 1 AND 31),
                    start_at TEXT NOT NULL,
                    end_type TEXT NOT NULL DEFAULT 'never'
                      CHECK (end_type IN ('never', 'date', 'count')),
                    end_date TEXT NULL,
                    max_occurrences INTEGER NULL CHECK (max_occurrences IS NULL OR max_occurrences > 0),
                    generated_occurrences INTEGER NOT NULL DEFAULT 0,
                    default_reminder_enabled INTEGER NOT NULL DEFAULT 0
                      CHECK (default_reminder_enabled IN (0, 1)),
                    default_reminder_offset_minutes INTEGER NOT NULL DEFAULT 0 CHECK (default_reminder_offset_minutes >= 0),
                    next_occurrence_at TEXT NULL,
                    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                ALTER TABLE notes ADD COLUMN scheduled_at TEXT NULL;
                ALTER TABLE notes ADD COLUMN repeat_series_id INTEGER NULL
                  REFERENCES repeat_series(id) ON DELETE SET NULL;
                ALTER TABLE notes ADD COLUMN repeat_occurrence_at TEXT NULL;
                ALTER TABLE notes ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 0
                  CHECK (reminder_enabled IN (0, 1));
                ALTER TABLE notes ADD COLUMN reminder_at TEXT NULL;
                ALTER TABLE notes ADD COLUMN reminder_offset_minutes INTEGER NOT NULL DEFAULT 0
                  CHECK (reminder_offset_minutes >= 0);
                ALTER TABLE notes ADD COLUMN reminder_triggered_at TEXT NULL;

                CREATE INDEX IF NOT EXISTS idx_notes_reminder_pending
                  ON notes(reminder_enabled, reminder_at, reminder_triggered_at, completed);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_repeat_occurrence
                  ON notes(repeat_series_id, repeat_occurrence_at)
                  WHERE repeat_series_id IS NOT NULL AND repeat_occurrence_at IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_repeat_series_next
                  ON repeat_series(active, next_occurrence_at);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "separate plan time and all-day reminder metadata",
            sql: r#"
                ALTER TABLE notes ADD COLUMN is_all_day INTEGER NOT NULL DEFAULT 0
                  CHECK (is_all_day IN (0, 1));
                ALTER TABLE notes ADD COLUMN all_day_reminder_time TEXT NULL;
                ALTER TABLE repeat_series ADD COLUMN default_is_all_day INTEGER NOT NULL DEFAULT 0
                  CHECK (default_is_all_day IN (0, 1));
                ALTER TABLE repeat_series ADD COLUMN default_all_day_reminder_time TEXT NULL;

                -- The old top-level due date becomes an all-day plan when no more
                -- precise scheduled time exists. Keep due_at itself for rollback/export compatibility.
                UPDATE notes
                  SET scheduled_at = due_at || 'T00:00:00', is_all_day = 1
                  WHERE scheduled_at IS NULL AND due_at IS NOT NULL AND length(due_at) >= 10;

                -- Recover the offset from old independent reminder timestamps whenever possible.
                -- reminder_at is intentionally never cleared: unconvertible legacy reminders remain active.
                UPDATE notes
                  SET reminder_offset_minutes = CAST(ROUND(
                    (julianday(scheduled_at) - julianday(reminder_at)) * 1440
                  ) AS INTEGER)
                  WHERE scheduled_at IS NOT NULL AND reminder_at IS NOT NULL
                    AND julianday(scheduled_at) >= julianday(reminder_at);

                UPDATE notes
                  SET all_day_reminder_time = COALESCE(strftime('%H:%M', reminder_at, 'localtime'), '09:00')
                  WHERE is_all_day = 1 AND reminder_enabled = 1;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add persistent board columns and note placement",
            sql: r#"
                CREATE TABLE IF NOT EXISTS board_columns (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    type TEXT NOT NULL DEFAULT 'custom'
                      CHECK (type IN ('system', 'custom')),
                    status TEXT NOT NULL DEFAULT 'doing'
                      CHECK (status IN ('todo', 'doing', 'completed')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT OR IGNORE INTO board_columns
                  (id, name, sort_order, type, status, created_at, updated_at) VALUES
                  ('todo', '待处理', 10, 'system', 'todo', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                  ('doing', '进行中', 20, 'custom', 'doing', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                  ('completed', '已完成', 30, 'system', 'completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

                ALTER TABLE notes ADD COLUMN board_column_id TEXT NULL
                  REFERENCES board_columns(id) ON DELETE RESTRICT;
                ALTER TABLE notes ADD COLUMN board_order INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo', 'doing', 'completed'));
                ALTER TABLE notes ADD COLUMN previous_board_column_id TEXT NULL
                  REFERENCES board_columns(id) ON DELETE SET NULL;

                UPDATE notes
                  SET board_column_id = CASE WHEN completed = 1 THEN 'completed' ELSE 'todo' END,
                      status = CASE WHEN completed = 1 THEN 'completed' ELSE 'todo' END,
                      board_order = sort_order;
                CREATE INDEX IF NOT EXISTS idx_notes_board_order
                  ON notes(board_column_id, board_order, created_at);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "separate scheduled date and explicit time",
            sql: MIGRATION_6_SQL,
            kind: MigrationKind::Up,
        },
    ]
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "打开对话看板", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出对话看板", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::new()
        .tooltip("对话看板")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, ..
            }) {
                restore_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => restore_main_window(app),
            "tray-quit" => {
                let _ = app.emit_to("main", "tray-quit-requested", ());
            }
            _ => {}
        });
    let icon = app.default_window_icon().expect("无法加载托盘图标");
    tray.icon(icon.clone()).build(app)?;
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
fn show_reminder_notification(
    app: tauri::AppHandle,
    note_id: i64,
    title: String,
    details: String,
    context: String,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    let app_id = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let activation_app = app.clone();
    Toast::new(&app_id)
        .title(&title)
        .text1(&details)
        .text2(&context)
        .on_activated(move |_| {
            restore_main_window(&activation_app);
            let _ = activation_app.emit("notification-activated", note_id);
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn show_reminder_notification(
    _app: tauri::AppHandle,
    _note_id: i64,
    _title: String,
    _details: String,
    _context: String,
) -> Result<(), String> {
    Err("原生 Windows 通知仅在 Windows 上可用".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:desktop-notes.db", migrations())
                .build(),
        )
        .setup(|app| {
            setup_tray(app)?;
            chat_sync::start_chat_sync(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::Resized(_))
                && window.is_minimized().unwrap_or(false)
            {
                let _ = window.hide();
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            chat_sync::get_chat_sync_status,
            chat_sync::get_chat_sync_tasks,
            chat_sync::get_chat_task_activity,
            chat_sync::create_chat_board_task,
            chat_sync::list_chat_board_threads,
            chat_sync::open_chat_board_thread,
            chat_sync::send_chat_board_task,
            chat_sync::refresh_chat_board_dispatches,
            chat_sync::set_chat_sync_task_archived,
            chat_sync::get_chat_sync_projects,
            chat_sync::get_chat_sync_project_usage,
            chat_sync::analyze_chat_project_requirements,
            chat_sync::save_chat_sync_project,
            chat_sync::set_chat_sync_project_hidden,
            chat_sync::configure_chat_sync,
            chat_sync::retry_chat_sync,
            chat_sync::undo_chat_sync,
            show_reminder_notification,
            sync_analysis::get_sync_analysis_config,
            sync_analysis::save_sync_analysis_config,
            sync_analysis::clear_sync_analysis_config,
            sync_analysis::set_ai_card_naming,
        ])
        .run(tauri::generate_context!())
        .expect("运行对话看板时发生错误");
}
