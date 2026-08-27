// Re-export the deploy's build stamp as compile-time env, so /api/v1/version can
// report the git commit the binary was built from. A plain `env!`/`option_env!`
// in the source doesn't track env changes, so a changed stamp wouldn't force a
// rebuild of the version handler; `rerun-if-env-changed` here does.
fn main() {
    for var in ["TJ_AGENT_COMMIT", "TJ_AGENT_RELEASE"] {
        println!("cargo:rerun-if-env-changed={var}");
        let val = std::env::var(var).unwrap_or_default();
        println!("cargo:rustc-env={var}={val}");
    }
}
