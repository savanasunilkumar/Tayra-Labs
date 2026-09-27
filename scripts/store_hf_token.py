"""Prompt locally for a read-only Hugging Face token and store it in this pilot's Secret Manager."""
import getpass
import subprocess
import sys

PROJECT = "video-api-dev-509820"
SECRET = "video-api-hf-token"


def main():
    if not sys.stdin.isatty():
        raise SystemExit("Run this directly in your terminal so the token stays hidden.")
    print(f"Store a read-only Hugging Face token in {PROJECT}/{SECRET}.")
    print("Only the model-staging service account is granted runtime access. The token is not saved locally.")
    token = getpass.getpass("Hugging Face read-only token (hidden): ").strip()
    if not token.startswith("hf_") or len(token) < 20:
        raise SystemExit("That does not look like a Hugging Face token; nothing was stored.")
    result = subprocess.run([
        "gcloud", "secrets", "versions", "add", SECRET, f"--project={PROJECT}",
        "--data-file=-", "--quiet", "--format=value(name)",
    ], input=token, capture_output=True, text=True)
    token = ""
    if result.returncode:
        raise SystemExit("Secret storage failed. Check Google login and Secret Manager permissions; token was not printed.")
    print("Token stored securely. Return to the chat and say 'token stored'.")


if __name__ == "__main__":
    main()
