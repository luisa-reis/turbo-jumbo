//! Entry point: `tj-agent` reads agent.yaml — override the path with
//! TJ_AGENT_CONFIG — and serves the storage protocol. Same config file the
//! TS reference agent reads; see agent.yaml.sample.

mod config;
mod error;
mod hashing;
mod ndjson;
mod ops;
mod prune;
mod refs;
mod safetensors;
mod server;
mod storage;
mod wire;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt().init();

    let file = std::env::var("TJ_AGENT_CONFIG").unwrap_or_else(|_| "./agent.yaml".to_string());
    let cfg = match config::AgentConfig::load(&file) {
        Ok(cfg) => cfg,
        Err(message) => {
            eprintln!("agent: {message}");
            return ExitCode::FAILURE;
        }
    };
    if cfg.token.is_none() {
        tracing::warn!("no token configured — every caller is trusted");
    }

    let roots: Vec<&str> = cfg.roots.names();
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("agent: cannot listen on :{}: {e}", cfg.port);
            return ExitCode::FAILURE;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(cfg.port);
    println!(
        "turbo-jumbo agent listening on :{port} (roots: {})",
        roots.join(", ")
    );

    let app = server::router(server::AppState::new(cfg));
    match axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("agent: server error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Resolve on SIGINT or SIGTERM, letting in-flight requests finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
}
