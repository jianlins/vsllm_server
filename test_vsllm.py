import requests

url = "http://localhost:8801/v1/chat/completions"
payload = {
    "messages": [
        {"role": "user", "content": "Hello, VSLLM!"}
    ]
}
headers = {"Content-Type": "application/json"}

response = requests.post(url, json=payload, headers=headers)
print("Status code:", response.status_code)
print("Response:", response.json())
