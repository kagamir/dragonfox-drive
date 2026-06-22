//! Unified API error type implementing `IntoResponse`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("invalid request: {0}")]
    BadRequest(String),

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("not found")]
    NotFound,

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("payload too large")]
    PayloadTooLarge,

    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => ApiError::NotFound,
            other => ApiError::Internal(anyhow::anyhow!(other)),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        // Log internal errors with full detail.
        if let ApiError::Internal(e) = &self {
            tracing::error!(error = ?e, "internal server error");
        }

        let message = if matches!(self, ApiError::Internal(_)) {
            "internal server error".to_string()
        } else {
            self.to_string()
        };

        let body = Json(json!({ "error": message }));
        (status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use sqlx::Error as SqlxError;

    #[test]
    fn bad_request_maps_to_400() {
        let resp = ApiError::BadRequest("nope".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn unauthorized_maps_to_401() {
        assert_eq!(
            ApiError::Unauthorized.into_response().status(),
            StatusCode::UNAUTHORIZED,
        );
    }

    #[test]
    fn forbidden_maps_to_403() {
        assert_eq!(
            ApiError::Forbidden.into_response().status(),
            StatusCode::FORBIDDEN,
        );
    }

    #[test]
    fn not_found_maps_to_404() {
        assert_eq!(
            ApiError::NotFound.into_response().status(),
            StatusCode::NOT_FOUND,
        );
    }

    #[test]
    fn conflict_maps_to_409() {
        assert_eq!(
            ApiError::Conflict("dup".into()).into_response().status(),
            StatusCode::CONFLICT,
        );
    }

    #[test]
    fn payload_too_large_maps_to_413() {
        assert_eq!(
            ApiError::PayloadTooLarge.into_response().status(),
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }

    #[test]
    fn internal_maps_to_500() {
        assert_eq!(
            ApiError::Internal(anyhow::anyhow!("boom")).into_response().status(),
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    #[tokio::test]
    async fn internal_body_does_not_leak_detail() {
        let resp =
            ApiError::Internal(anyhow::anyhow!("secret detail")).into_response();
        let bytes = to_bytes(resp.into_body(), 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "internal server error");
        assert!(
            !bytes.windows(6).any(|w| w == b"secret"),
            "internal detail must not appear in the response body"
        );
    }

    #[tokio::test]
    async fn bad_request_body_contains_the_message() {
        let resp =
            ApiError::BadRequest("a specific reason".into()).into_response();
        let bytes = to_bytes(resp.into_body(), 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "invalid request: a specific reason");
    }

    #[test]
    fn sqlx_row_not_found_maps_to_api_not_found() {
        let err: ApiError = SqlxError::RowNotFound.into();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[test]
    fn sqlx_other_error_maps_to_internal() {
        let err: ApiError = SqlxError::PoolClosed.into();
        assert!(matches!(err, ApiError::Internal(_)));
    }
}
