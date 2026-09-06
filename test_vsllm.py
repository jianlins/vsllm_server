"""End-to-end checks for a running VSLLM Server.

These require the VS Code extension to be running with the server started, so
under pytest the whole module skips when nothing is listening. Run directly
(`python test_vsllm.py`) for a verbose manual smoke test.

Set VSLLM_API_KEY when the server has `vsllmServer.apiKey` configured.
"""

import json
import os

import pytest
import requests

BASE_URL = os.environ.get("VSLLM_BASE_URL", "http://localhost:8801")
API_KEY = os.environ.get("VSLLM_API_KEY", "")

HEADERS = {"Content-Type": "application/json"}
if API_KEY:
    HEADERS["Authorization"] = f"Bearer {API_KEY}"


def _require_server():
    """Returns None when the server is reachable, or a reason to skip."""
    try:
        requests.get(f"{BASE_URL}/v1/models", headers=HEADERS, timeout=5)
    except requests.exceptions.ConnectionError:
        return f"VSLLM server not running at {BASE_URL}"
    return None


@pytest.fixture(scope="session", autouse=True)
def server_available():
    reason = _require_server()
    if reason:
        pytest.skip(reason, allow_module_level=True)


def _first_model_id():
    response = requests.get(f"{BASE_URL}/v1/models", headers=HEADERS, timeout=30)
    return response.json()["data"][0]["id"]


def test_models_endpoint():
    """GET /v1/models lists the real available models."""
    response = requests.get(f"{BASE_URL}/v1/models", headers=HEADERS, timeout=30)
    assert response.status_code == 200, response.text

    data = response.json()
    assert data["object"] == "list"
    assert len(data["data"]) >= 1, "expected at least one model"
    for entry in data["data"]:
        assert entry["id"], "model entries must carry a non-empty id"
        assert entry["object"] == "model"


def test_models_endpoint_ignores_query_string():
    """Routing is by path, so query strings must not 404."""
    response = requests.get(f"{BASE_URL}/v1/models?limit=1", headers=HEADERS, timeout=30)
    assert response.status_code == 200, response.text


def test_unknown_route_is_404():
    response = requests.get(f"{BASE_URL}/v1/nope", headers=HEADERS, timeout=30)
    assert response.status_code == 404, response.text


def test_non_streaming():
    """Non-streaming chat completion returns usable content."""
    payload = {"messages": [{"role": "user", "content": "Hello, VSLLM!"}]}
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=120
    )
    assert response.status_code == 200, response.text

    data = response.json()
    choice = data["choices"][0]
    assert choice["message"]["role"] == "assistant"
    assert choice["message"]["content"], "expected non-empty completion content"
    assert choice["finish_reason"] == "stop"
    assert data["model"], "response must report the model that served it"


def test_content_parts_array():
    """Array content made of text parts is accepted."""
    payload = {
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "Say the word ok."}]}
        ]
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=120
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"]


def test_unsupported_content_part_is_rejected():
    """Non-text parts are refused rather than silently dropped."""
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                ],
            }
        ]
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=30
    )
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "unsupported_content_part"


def test_streaming():
    """Streaming chat completion emits SSE chunks and terminates with [DONE]."""
    payload = {
        "messages": [{"role": "user", "content": "Hello, VSLLM! Tell me a short joke."}],
        "stream": True,
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions",
        json=payload,
        headers=HEADERS,
        stream=True,
        timeout=120,
    )
    assert response.status_code == 200, response.text
    assert response.headers.get("Content-Type", "").startswith("text/event-stream")

    full_content = ""
    finish_reason = None
    saw_done = False

    for line in response.iter_lines():
        if not line:
            continue
        line_str = line.decode("utf-8")
        if not line_str.startswith("data: "):
            continue

        data_str = line_str[6:]
        if data_str == "[DONE]":
            saw_done = True
            break

        data = json.loads(data_str)
        assert "error" not in data, f"stream reported an error: {data}"
        choice = data["choices"][0]
        full_content += choice.get("delta", {}).get("content", "") or ""
        finish_reason = choice.get("finish_reason") or finish_reason

    assert saw_done, "stream never emitted the [DONE] sentinel"
    assert full_content, "expected non-empty streamed content"
    assert finish_reason == "stop"


def test_unknown_model_is_ignored():
    """An unknown requested model no longer fails; the server just ignores it."""
    payload = {
        "model": "definitely-not-a-real-model",
        "messages": [{"role": "user", "content": "Hi"}],
    }
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=120
    )
    assert response.status_code == 200, response.text
    assert response.json()["model"] != "definitely-not-a-real-model"


def test_requested_model_is_ignored():
    """The client's `model` field never picks the model; the extension's configured model always answers."""
    real_model_id = _first_model_id()
    reported_models = set()
    for requested in ("definitely-not-a-real-model", real_model_id):
        payload = {"model": requested, "messages": [{"role": "user", "content": "Say ok."}]}
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=120
        )
        assert response.status_code == 200, response.text
        reported_models.add(response.json()["model"])
    assert len(reported_models) == 1, "server must report the same model regardless of the request's model field"


def test_invalid_json_is_400():
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", data="{not json", headers=HEADERS, timeout=30
    )
    assert response.status_code == 400, response.text
    assert response.json()["error"]["type"] == "invalid_request_error"


def test_missing_messages_is_400():
    response = requests.post(
        f"{BASE_URL}/v1/chat/completions", json={"messages": []}, headers=HEADERS, timeout=30
    )
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "missing_messages"


def test_oversized_body_is_rejected():
    """Bodies past vsllmServer.maxRequestBytes (default 1 MiB) are refused."""
    payload = {"messages": [{"role": "user", "content": "x" * (2 * 1024 * 1024)}]}
    try:
        response = requests.post(
            f"{BASE_URL}/v1/chat/completions", json=payload, headers=HEADERS, timeout=30
        )
    except requests.exceptions.ConnectionError:
        # The server may close the connection before the client finishes sending.
        return
    assert response.status_code == 413, response.text


@pytest.mark.skipif(not API_KEY, reason="requires vsllmServer.apiKey plus VSLLM_API_KEY")
def test_missing_api_key_is_401():
    response = requests.get(
        f"{BASE_URL}/v1/models", headers={"Content-Type": "application/json"}, timeout=30
    )
    assert response.status_code == 401, response.text
    assert response.json()["error"]["code"] == "invalid_api_key"


@pytest.mark.skipif(not API_KEY, reason="requires vsllmServer.apiKey plus VSLLM_API_KEY")
def test_wrong_api_key_is_401():
    headers = {"Content-Type": "application/json", "Authorization": "Bearer wrong-key"}
    response = requests.get(f"{BASE_URL}/v1/models", headers=headers, timeout=30)
    assert response.status_code == 401, response.text


def _run_manually():
    reason = _require_server()
    if reason:
        print(f"SKIPPED: {reason}")
        return

    checks = [
        test_models_endpoint,
        test_models_endpoint_ignores_query_string,
        test_unknown_route_is_404,
        test_non_streaming,
        test_content_parts_array,
        test_unsupported_content_part_is_rejected,
        test_streaming,
        test_unknown_model_is_ignored,
        test_requested_model_is_ignored,
        test_invalid_json_is_400,
        test_missing_messages_is_400,
        test_oversized_body_is_rejected,
    ]

    failures = 0
    for check in checks:
        print("=" * 60)
        print(check.__name__)
        print("=" * 60)
        try:
            check()
            print("PASS\n")
        except AssertionError as err:
            failures += 1
            print(f"FAIL: {err}\n")

    print("=" * 60)
    print(f"{len(checks) - failures}/{len(checks)} checks passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    print("\nVSLLM Server Test Suite")
    print(f"Target: {BASE_URL}\n")
    _run_manually()
