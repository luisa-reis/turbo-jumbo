//! NDJSON streaming responses: a channel whose receiving end is the
//! response body. The sender lives with the work (usually a blocking
//! task); the client going away closes the receiver, which every send
//! reports — cancellation is the connection, exactly as the protocol says.

use std::convert::Infallible;

use axum::body::{Body, Bytes};
use axum::response::Response;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub struct NdjsonSender {
    tx: mpsc::Sender<Result<Bytes, Infallible>>,
}

impl NdjsonSender {
    /// Send one frame from blocking context; false when the client is gone.
    pub fn blocking_json(&self, frame: &impl Serialize) -> bool {
        let mut line = match serde_json::to_vec(frame) {
            Ok(line) => line,
            Err(_) => return false,
        };
        line.push(b'\n');
        self.tx.blocking_send(Ok(Bytes::from(line))).is_ok()
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// A fresh NDJSON response and the sender that feeds it.
pub fn ndjson_response() -> (NdjsonSender, Response) {
    let (tx, rx) = mpsc::channel(64);
    let response = Response::builder()
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-store")
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .expect("static response parts");
    (NdjsonSender { tx }, response)
}

impl Clone for NdjsonSender {
    fn clone(&self) -> Self {
        NdjsonSender {
            tx: self.tx.clone(),
        }
    }
}

impl NdjsonSender {
    /// Send one frame from async context; false when the client is gone.
    pub async fn json(&self, frame: &impl Serialize) -> bool {
        let mut line = match serde_json::to_vec(frame) {
            Ok(line) => line,
            Err(_) => return false,
        };
        line.push(b'\n');
        self.tx.send(Ok(Bytes::from(line))).await.is_ok()
    }
}
