//! agent.yaml, exactly as the TS reference agent reads it: a port, an
//! optional bearer token, and the directories behind the roots — at least
//! one, each existing. Unknown keys are refused: a typoed `tokn` silently
//! ignored would be an agent with no auth.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::refs::Root;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub port: u16,
    pub token: Option<String>,
    pub roots: RootsConfig,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootsConfig {
    pub models: Option<PathBuf>,
    pub cold: Option<PathBuf>,
    pub lemonade: Option<PathBuf>,
}

impl RootsConfig {
    pub fn get(&self, root: Root) -> Option<&Path> {
        match root {
            Root::Models => self.models.as_deref(),
            Root::Cold => self.cold.as_deref(),
            Root::Lemonade => self.lemonade.as_deref(),
        }
    }

    pub fn names(&self) -> Vec<&'static str> {
        Root::ALL
            .iter()
            .filter(|r| self.get(**r).is_some())
            .map(|r| r.as_str())
            .collect()
    }
}

impl AgentConfig {
    pub fn load(file: &str) -> Result<Self, String> {
        let raw = std::fs::read_to_string(file).map_err(|e| format!("cannot read {file}: {e}"))?;
        let cfg: AgentConfig = serde_yaml::from_str(&raw).map_err(|e| format!("{file}: {e}"))?;
        cfg.validate(file)?;
        Ok(cfg)
    }

    fn validate(&self, file: &str) -> Result<(), String> {
        // Port 0 is legal on purpose: it picks a free port, which is how
        // the conformance tests run this binary (the announced port is on
        // the startup line).
        let mut any = false;
        for root in Root::ALL {
            if let Some(dir) = self.roots.get(root) {
                any = true;
                if !dir.is_dir() {
                    return Err(format!(
                        "{file}: roots.{} ({}) does not exist",
                        root.as_str(),
                        dir.display()
                    ));
                }
            }
        }
        if !any {
            return Err(format!("{file}: no roots configured"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> Result<AgentConfig, String> {
        serde_yaml::from_str::<AgentConfig>(yaml).map_err(|e| e.to_string())
    }

    #[test]
    fn parses_the_sample_shape() {
        let cfg = parse("port: 3900\ntoken: t\nroots:\n  models: /tmp\n").unwrap();
        assert_eq!(cfg.port, 3900);
        assert_eq!(cfg.token.as_deref(), Some("t"));
        assert!(cfg.roots.models.is_some());
        assert!(cfg.roots.cold.is_none());
    }

    #[test]
    fn refuses_unknown_keys() {
        // A typoed `tokn` must fail loudly, not run an agent with no auth.
        assert!(parse("port: 1\ntokn: t\nroots: {models: /tmp}\n").is_err());
        // A deliberately absent token is legal — main() warns instead.
        assert!(parse("port: 1\nroots: {models: /tmp}\n").is_ok());
    }

    #[test]
    fn validate_needs_a_real_root() {
        let cfg = parse("port: 3900\nroots: {models: /nonexistent-tj}\n").unwrap();
        assert!(cfg.validate("f").unwrap_err().contains("does not exist"));
        let cfg = parse("port: 3900\nroots: {}\n").unwrap();
        assert!(cfg.validate("f").unwrap_err().contains("no roots"));
    }
}
