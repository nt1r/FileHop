use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn liveness_does_not_claim_business_readiness() {
    let root = tempfile::tempdir().unwrap();
    let app = backend::app(root.path().join("database"), root.path().join("files"));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/internal/live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    for (path, expected) in [
        ("/api/session", StatusCode::UNAUTHORIZED),
        ("/api/messages", StatusCode::UNAUTHORIZED),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}
