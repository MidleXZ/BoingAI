use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{sse::{Event, Sse}, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

// FFI to C++ lib
extern "C" {
    fn boing_sanitize(input: *const i8) -> *mut i8;
    fn boing_token_estimate(text: *const i8) -> i32;
    fn boing_format_prompt(system: *const i8, user: *const i8) -> *mut i8;
    fn boing_free(ptr: *mut i8);
    fn boing_version() -> *const i8;
}

fn cpp_sanitize(s: &str) -> String {
    let c = CString::new(s).unwrap_or_default();
    unsafe {
        let p = boing_sanitize(c.as_ptr());
        if p.is_null() { return String::new(); }
        let r = CStr::from_ptr(p).to_string_lossy().into_owned();
        boing_free(p);
        r
    }
}

fn cpp_tokens(s: &str) -> i32 {
    let c = CString::new(s).unwrap_or_default();
    unsafe { boing_token_estimate(c.as_ptr()) }
}

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    ollama_url: String,
    csharp_url: String,
    model: String,
}

#[derive(Deserialize)]
struct ChatRequest {
    conversation_id: Option<String>,
    message: String,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    web_search: bool,
}

// ----- Web search (DuckDuckGo HTML, no API key required) -----

#[derive(Deserialize)]
struct SearchRequest {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn html_decode(s: &str) -> String {
    // Decode &amp; last so "&amp;lt;" does not accidentally become "<".
    let out = s
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ");
    out.replace("&amp;", "&")
}

/// Parse DuckDuckGo's HTML results page into structured results.
fn parse_ddg_results(html: &str, limit: usize) -> Vec<SearchResult> {
    let marker = "class=\"result__a\"";
    let mut results = Vec::new();
    let mut pos = 0usize;

    while results.len() < limit {
        let Some(start) = html[pos..].find(marker) else { break; };
        let abs = pos + start;

        // A result block ends where the next result anchor starts (or end of page).
        let block_end = html[abs + marker.len()..]
            .find(marker)
            .map(|n| abs + marker.len() + n)
            .unwrap_or(html.len());
        let block = &html[abs..block_end];

        // DuckDuckGo wraps links: //duckduckgo.com/l/?uddg=<encoded target>
        let Some(href_pos) = block.find("href=\"") else {
            pos = block_end;
            continue;
        };
        let href_start = href_pos + 6;
        let Some(href_end) = block[href_start..].find('"') else {
            pos = block_end;
            continue;
        };
        let raw_url = &block[href_start..href_start + href_end];
        let clean_url = if let Some(qpos) = raw_url.find("uddg=") {
            let rest = &raw_url[qpos + 5..];
            let amp = rest.find('&').unwrap_or(rest.len());
            urlencoding::decode(&rest[..amp])
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| raw_url.to_string())
        } else {
            raw_url.to_string()
        };

        // Title is the text inside the anchor's opening tag.
        let title = match block.find('>') {
            Some(t) => {
                let from = t + 1;
                let to = block[from..].find('<').map(|e| from + e).unwrap_or(block.len());
                html_decode(block[from..to].trim())
            }
            None => String::new(),
        };

        // Snippet lives in a result__snippet element within this block.
        let snippet = block
            .find("class=\"result__snippet\"")
            .and_then(|spos| {
                let start = block[spos..].find('>')? + spos + 1;
                let end = block[start..].find('<')? + start;
                Some(html_decode(block[start..end].trim()))
            })
            .unwrap_or_default();

        if !title.is_empty() && !clean_url.is_empty() {
            results.push(SearchResult { title, url: clean_url, snippet });
        }
        pos = block_end;
    }

    results
}

async fn duckduckgo_search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Vec<SearchResult> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );

    let resp = match client
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        )
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("web search request failed: {e}");
            return vec![];
        }
    };

    let html = match resp.text().await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!("web search body failed: {e}");
            return vec![];
        }
    };

    parse_ddg_results(&html, limit)
}

async fn web_search(State(s): State<Arc<AppState>>, Json(req): Json<SearchRequest>) -> Response {
    let limit = req.limit.unwrap_or(5).clamp(1, 10);
    let results = duckduckgo_search(&s.http, &req.query, limit).await;
    Json(serde_json::json!({
        "query": req.query,
        "results": results,
    })).into_response()
}

fn search_context(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return String::new();
    }
    let mut ctx = String::from("\n\nHere is information from web search results you can use to answer:\n");
    for (i, r) in results.iter().enumerate() {
        ctx.push_str(&format!("[{}] Title: {}\nURL: {}\nSnippet: {}\n\n", i + 1, r.title, r.url, r.snippet));
    }
    ctx.push_str("Use the above web search results to inform your answer. Cite sources by URL when helpful.\n");
    ctx
}

#[derive(Serialize)]
struct ChatResponse {
    conversation_id: String,
    reply: String,
    tokens_in: i32,
    tokens_out: i32,
}

#[derive(Serialize, Deserialize, Clone)]
struct CsMessage {
    #[serde(rename = "role")]
    role: String,
    #[serde(rename = "content")]
    content: String,
    #[serde(default, rename = "timestamp")]
    timestamp: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CsConversation {
    #[serde(rename = "id")]
    id: String,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "messages")]
    messages: Vec<CsMessage>,
}

#[derive(Serialize)]
struct CsMessageInput {
    #[serde(rename = "role")]
    role: String,
    #[serde(rename = "content")]
    content: String,
}

#[derive(Deserialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OllamaChatResp {
    message: OllamaMessage,
}

async fn health(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let v = unsafe {
        CStr::from_ptr(boing_version()).to_string_lossy().into_owned()
    };
    Json(serde_json::json!({
        "status": "ok",
        "service": "boingai",
        "cpp": v,
        "model": s.model,
    }))
}

async fn list_conversations(State(s): State<Arc<AppState>>) -> Response {
    let url = format!("{}/conversations", s.csharp_url);
    match s.http.get(&url).send().await {
        Ok(r) => {
            let body: serde_json::Value = r.json().await.unwrap_or(serde_json::json!([]));
            Json(body).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("memory service: {e}")).into_response(),
    }
}

async fn get_conversation(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let url = format!("{}/conversations/{}", s.csharp_url, id);
    match s.http.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
            Json(body).into_response()
        }
        Ok(r) => (StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY), "not found").into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e}")).into_response(),
    }
}

async fn window_minimize() -> Response {
    // Use xdotool to minimize the BoingAI window
    let _ = std::process::Command::new("xdotool")
        .args(["search", "--name", "BoingAI", "windowminimize"])
        .output();
    StatusCode::NO_CONTENT.into_response()
}

async fn window_close() -> Response {
    let _ = std::process::Command::new("xdotool")
        .args(["search", "--name", "BoingAI", "windowclose"])
        .output();
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_conversation(State(s): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let url = format!("{}/conversations/{}", s.csharp_url, id);
    match s.http.delete(&url).send().await {
        Ok(r) if r.status().is_success() || r.status() == StatusCode::NO_CONTENT => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(r) => (StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY), "delete failed").into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e}")).into_response(),
    }
}

async fn chat(State(s): State<Arc<AppState>>, Json(req): Json<ChatRequest>) -> Response {
    let user_text = cpp_sanitize(&req.message);
    let tokens_in = cpp_tokens(&user_text);

    // Optional web search: prepend results to the system prompt
    let sys = if req.web_search {
        let limit = 5usize;
        let results = duckduckgo_search(&s.http, &user_text, limit).await;
        let base = req.system_prompt.clone().unwrap_or_else(|| "You are BoingAI, a helpful, concise and friendly assistant. Keep answers clear and minimal.".to_string());
        base + &search_context(&results)
    } else {
        req.system_prompt.clone().unwrap_or_else(|| "You are BoingAI, a helpful, concise and friendly assistant. Keep answers clear and minimal.".to_string())
    };

    // Resolve conversation id
    let conv_id = match req.conversation_id.clone() {
        Some(id) => id,
        None => {
            let url = format!("{}/conversations", s.csharp_url);
            match s.http.post(&url).send().await {
                Ok(r) => {
                    let v: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                    v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string()
                }
                Err(_) => return (StatusCode::BAD_GATEWAY, "memory service unavailable").into_response(),
            }
        }
    };
    if conv_id.is_empty() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not create conversation").into_response();
    }

    // store user message
    let url = format!("{}/conversations/{}/messages", s.csharp_url, conv_id);
    let _ = s.http.post(&url).json(&CsMessageInput { role: "user".into(), content: user_text.clone() }).send().await;

    // fetch history
    let hist_url = format!("{}/conversations/{}", s.csharp_url, conv_id);
    let mut messages: Vec<serde_json::Value> = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": sys
    }));
    if let Ok(r) = s.http.get(&hist_url).send().await {
        if let Ok(conv) = r.json::<CsConversation>().await {
            for m in conv.messages.iter() {
                if m.role == "user" || m.role == "assistant" {
                    messages.push(serde_json::json!({"role": m.role, "content": m.content}));
                }
            }
        }
    }
    // remove the just-added duplicate? history includes user msg already; fine, Ollama handles. But we added user msg above, so history includes it. Good - no duplicate push needed.

    // call ollama
    let mut ollama_body = serde_json::json!({
        "model": s.model,
        "messages": messages,
        "stream": false,
    });
    let mut opts = serde_json::Map::new();
    if let Some(t) = req.temperature { opts.insert("temperature".into(), serde_json::json!(t)); }
    if let Some(p) = req.top_p { opts.insert("top_p".into(), serde_json::json!(p)); }
    if !opts.is_empty() { ollama_body["options"] = serde_json::Value::Object(opts); }
    let ollama_url = format!("{}/api/chat", s.ollama_url);
    let reply_raw = match s.http.post(&ollama_url).json(&ollama_body).send().await {
        Ok(r) => {
            let v: OllamaChatResp = r.json().await.unwrap_or(OllamaChatResp {
                message: OllamaMessage { role: "assistant".into(), content: "Sorry, I couldn't generate a reply.".into() },
            });
            v.message.content
        }
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("ollama: {e}")).into_response();
        }
    };

    let reply = cpp_sanitize(&reply_raw);
    let tokens_out = cpp_tokens(&reply);

    // store assistant message
    let _ = s.http.post(&url).json(&CsMessageInput { role: "assistant".into(), content: reply.clone() }).send().await;

    Json(ChatResponse {
        conversation_id: conv_id,
        reply,
        tokens_in,
        tokens_out,
    }).into_response()
}

async fn chat_stream(
    State(s): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Response {
    let user_text = cpp_sanitize(&req.message);
    let tokens_in = cpp_tokens(&user_text);

    // Optional web search: prepend results to the system prompt
    let sys = if req.web_search {
        let limit = 5usize;
        let results = duckduckgo_search(&s.http, &user_text, limit).await;
        let base = req.system_prompt.clone().unwrap_or_else(|| "You are BoingAI, a helpful, concise and friendly assistant. Keep answers clear and minimal.".to_string());
        base + &search_context(&results)
    } else {
        req.system_prompt.clone().unwrap_or_else(|| "You are BoingAI, a helpful, concise and friendly assistant. Keep answers clear and minimal.".to_string())
    };

    // Resolve conversation id
    let conv_id = match req.conversation_id.clone() {
        Some(id) => id,
        None => {
            let url = format!("{}/conversations", s.csharp_url);
            match s.http.post(&url).send().await {
                Ok(r) => {
                    let v: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                    v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string()
                }
                Err(_) => {
                    return (StatusCode::BAD_GATEWAY, "memory service unavailable").into_response();
                }
            }
        }
    };
    if conv_id.is_empty() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "could not create conversation").into_response();
    }

    // store user message
    let url = format!("{}/conversations/{}/messages", s.csharp_url, conv_id);
    let _ = s.http.post(&url).json(&CsMessageInput { role: "user".into(), content: user_text.clone() }).send().await;

    // fetch history
    let hist_url = format!("{}/conversations/{}", s.csharp_url, conv_id);
    let mut messages: Vec<serde_json::Value> = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": sys
    }));
    if let Ok(r) = s.http.get(&hist_url).send().await {
        if let Ok(conv) = r.json::<CsConversation>().await {
            for m in conv.messages.iter() {
                if m.role == "user" || m.role == "assistant" {
                    messages.push(serde_json::json!({"role": m.role, "content": m.content}));
                }
            }
        }
    }

    let mut ollama_body = serde_json::json!({
        "model": s.model,
        "messages": messages,
        "stream": true,
    });
    let mut opts = serde_json::Map::new();
    if let Some(t) = req.temperature { opts.insert("temperature".into(), serde_json::json!(t)); }
    if let Some(p) = req.top_p { opts.insert("top_p".into(), serde_json::json!(p)); }
    if !opts.is_empty() { ollama_body["options"] = serde_json::Value::Object(opts); }
    let ollama_url = format!("{}/api/chat", s.ollama_url);

    let resp = match s.http.post(&ollama_url).json(&ollama_body).send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("ollama: {e}")).into_response();
        }
    };

    let conv_id_clone = conv_id.clone();
    let csharp_url = s.csharp_url.clone();
    let http = s.http.clone();

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut full_reply = String::new();
        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // process complete lines
                    while let Some(nl) = buf.find('\n') {
                        let line = buf[..nl].trim().to_string();
                        buf = buf[nl+1..].to_string();
                        if line.is_empty() { continue; }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    full_reply.push_str(content);
                                    // pass raw token to preserve spaces; sanitize final reply on done
                                    yield Ok::<_, std::convert::Infallible>(Event::default().data(serde_json::json!({"token": content, "done": false}).to_string()));
                                }
                            }
                            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                // store assistant message
                                let url = format!("{}/conversations/{}/messages", csharp_url, conv_id_clone);
                                let _ = http.post(&url).json(&CsMessageInput { role: "assistant".into(), content: cpp_sanitize(&full_reply) }).send().await;
                                let tokens_out = cpp_tokens(&full_reply);
                                let reply = cpp_sanitize(&full_reply);
                                yield Ok(Event::default().data(serde_json::json!({"token": "", "done": true, "conversation_id": conv_id_clone, "tokens_in": tokens_in, "tokens_out": tokens_out, "reply": reply}).to_string()));
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    };

    Sse::new(stream).into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let state = Arc::new(AppState {
        http: reqwest::Client::new(),
        ollama_url: std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into()),
        csharp_url: std::env::var("CSHARP_URL").unwrap_or_else(|_| "http://localhost:5001".into()),
        model: std::env::var("MODEL").unwrap_or_else(|_| "qwen2.5:1.5b".into()),
    });

    // frontend dir
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "../frontend".into());

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/conversations", get(list_conversations))
        .route("/api/conversations/:id", get(get_conversation).delete(delete_conversation))
        .route("/api/chat", post(chat))
        .route("/api/chat/stream", post(chat_stream))
        .route("/api/search", post(web_search))
        .route("/api/window/minimize", post(window_minimize))
        .route("/api/window/close", post(window_close))
        .nest_service("/static", ServeDir::new(&frontend_dir))
        .fallback_service(ServeDir::new(&frontend_dir).append_index_html_on_directories(true))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    println!("BoingAI server listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
