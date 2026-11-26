use serde::Deserialize;
use std::{collections::BTreeMap, fs, io::ErrorKind, path::Path};

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case", default)]
pub struct ProjectCatalog {
    local_projects: BTreeMap<String, RegisteredProject>,
    project_order: Vec<String>,
    thread_project_assignments: BTreeMap<String, ProjectAssignment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredProject {
    pub name: String,
    #[serde(default)]
    pub root_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAssignment {
    project_kind: String,
    project_id: String,
}

impl ProjectCatalog {
    pub fn read(home: &Path) -> Result<Self, String> {
        match fs::read(home.join(".codex-global-state.json")) {
            Ok(data) => {
                serde_json::from_slice(&data).map_err(|_| "无法解析 Codex 本地项目清单".into())
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("无法读取 Codex 本地项目清单".into()),
        }
    }

    pub fn projects(&self) -> Vec<(&str, &RegisteredProject)> {
        let mut projects: Vec<_> = self
            .local_projects
            .iter()
            .map(|(id, project)| (id.as_str(), project))
            .collect();
        let positions: BTreeMap<_, _> = self
            .project_order
            .iter()
            .enumerate()
            .map(|(position, id)| (id.as_str(), position))
            .collect();
        projects.sort_by_key(|(id, _)| positions.get(id).copied().unwrap_or(usize::MAX));
        projects
    }

    pub fn contains(&self, id: &str) -> bool {
        self.local_projects.contains_key(id)
    }

    pub fn project_for(&self, session: &str, cwd: Option<&str>) -> Option<&str> {
        self.project_for_with_preference(session, cwd, |_| false)
    }

    pub fn project_for_with_preference(
        &self,
        session: &str,
        cwd: Option<&str>,
        preferred: impl Fn(&str) -> bool,
    ) -> Option<&str> {
        if let Some(assignment) = self.thread_project_assignments.get(session) {
            if assignment.project_kind == "local" && self.contains(&assignment.project_id) {
                return Some(&assignment.project_id);
            }
        }
        let cwd = normalized_path(cwd?);
        let mut best = None;
        let mut ambiguous = false;
        for (id, project) in &self.local_projects {
            for root in &project.root_paths {
                let root = normalized_path(root);
                if root.is_empty()
                    || !(cwd == root
                        || cwd
                            .strip_prefix(&root)
                            .is_some_and(|suffix| suffix.starts_with('/')))
                {
                    continue;
                }
                let rank = (root.len(), preferred(id));
                match best {
                    Some((_, current)) if current > rank => {}
                    Some((other, current)) if current == rank => ambiguous |= other != id,
                    _ => {
                        best = Some((id, rank));
                        ambiguous = false;
                    }
                }
            }
        }
        best.filter(|_| !ambiguous).map(|(id, _)| id.as_str())
    }
}

fn normalized_path(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.strip_prefix("//?/").unwrap_or(&path);
    let path = path.trim_end_matches('/');
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_registered_projects_and_resolves_root_or_explicit_assignment() {
        let catalog: ProjectCatalog = serde_json::from_str(
            r#"{
            "local-projects": {
                "a": {"name":"App", "rootPaths":["C:/dev/app"]},
                "b": {"name":"Shared name", "rootPaths":["C:/dev/app/web", "C:/other/app"]},
                "c": {"name":"Shared name", "rootPaths":["C:/unrelated/app"]},
                "d": {"name":"No sessions", "rootPaths":[]}
            },
            "project-order":["d","b","a"],
            "thread-project-assignments": {
                "assigned": {"projectKind":"local","projectId":"a"}
            }
        }"#,
        )
        .unwrap();
        let ids: Vec<_> = catalog.projects().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, ["d", "b", "a", "c"]);
        assert_eq!(
            catalog.project_for("assigned", Some("C:/dev/app/web")),
            Some("a")
        );
        assert_eq!(
            catalog.project_for("other", Some(r"C:\dev\app\web\src\")),
            Some("b")
        );
        assert_eq!(
            catalog.project_for("other", Some("C:/unrelated/app")),
            Some("c")
        );
        assert_eq!(
            catalog.project_for("other", Some("C:/dev/application")),
            None
        );
    }
}
