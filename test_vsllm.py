import requests
import json

BASE_URL = "http://localhost:8801"

def test_non_streaming():
    """Test non-streaming chat completion"""
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "messages": [
            {"role": "user", "content": "Hello, VSLLM!"}
        ]
    }
    headers = {"Content-Type": "application/json"}

    response = requests.post(url, json=payload, headers=headers)
    print("=" * 50)
    print("Non-Streaming Test")
    print("=" * 50)
    print("Status code:", response.status_code)
    print("Response:", response.json())
    print()


def test_streaming():
    """Test streaming chat completion (SSE format)"""
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "messages": [
            {"role": "user", "content": "Hello, VSLLM! Tell me a short joke."}
        ],
        "stream": True
    }
    headers = {"Content-Type": "application/json"}

    print("=" * 50)
    print("Streaming Test")
    print("=" * 50)
    
    response = requests.post(url, json=payload, headers=headers, stream=True)
    print("Status code:", response.status_code)
    print("Content-Type:", response.headers.get("Content-Type"))
    print()
    print("Streaming chunks:")
    print("-" * 30)
    
    full_content = ""
    for line in response.iter_lines():
        if line:
            line_str = line.decode('utf-8')
            print(f"Raw: {line_str}")
            
            # Parse SSE data
            if line_str.startswith("data: "):
                data_str = line_str[6:]  # Remove "data: " prefix
                if data_str == "[DONE]":
                    print("\n[Stream completed]")
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and len(data["choices"]) > 0:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_content += content
                            print(f"Content: {content}")
                        finish_reason = data["choices"][0].get("finish_reason")
                        if finish_reason:
                            print(f"Finish reason: {finish_reason}")
                except json.JSONDecodeError as e:
                    print(f"JSON parse error: {e}")
    
    print("-" * 30)
    print(f"Full assembled content: {full_content}")
    print()


def test_models_endpoint():
    """Test the /v1/models endpoint"""
    url = f"{BASE_URL}/v1/models"
    
    print("=" * 50)
    print("Models Endpoint Test")
    print("=" * 50)
    
    response = requests.get(url)
    print("Status code:", response.status_code)
    print("Response:", response.json())
    print()


if __name__ == "__main__":
    print("\nVSLLM Server Test Suite")
    print("=" * 50)
    print()
    
    # Test models endpoint
    test_models_endpoint()
    
    # Test non-streaming
    test_non_streaming()
    
    # Test streaming
    test_streaming()
