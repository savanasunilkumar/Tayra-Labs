from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from threading import RLock


class MemoryStore:
    def recent_jobs(self, tenant, limit=30):
        return sorted(self.find("jobs", "tenant_id", "==", tenant, limit=100000),
                      key=lambda job: job["created_at"], reverse=True)[:limit]

    def __init__(self):
        self.data = {}
        self.lock = RLock()
        self.fail_finish = False

    def get(self, collection, key):
        with self.lock:
            return deepcopy(self.data.get((collection, key)))

    def put(self, collection, key, value):
        if self.fail_finish and collection == "jobs" and value["status"] == "succeeded":
            raise RuntimeError("Simulated database outage")
        self.data[(collection, key)] = deepcopy(value)

    def transact(self, operation):
        with self.lock:
            before = deepcopy(self.data)
            try:
                return operation(self)
            except Exception:
                self.data = before
                raise

    def find(self, collection, field, operator, value, limit=100):
        matches = []
        for (kind, _), doc in self.data.items():
            actual = doc.get(field)
            if kind == collection and actual is not None:
                if (operator == "==" and actual == value) or (operator == "<=" and actual <= value):
                    matches.append(deepcopy(doc))
        return matches[:limit]


class MemoryObjects:
    def __init__(self):
        self.metadata, self.results = {}, {}
        self.deleted = []

    def upload_url(self, key, content_type):
        return f"https://storage.googleapis.com/test/{key}?X-Goog-Signature=example"

    def result_url(self, key, generation):
        return f"https://storage.googleapis.com/test/{key}?generation={generation}&X-Goog-Signature=example"

    def head(self, key):
        return self.metadata.get(key)

    def download(self, key, generation, path: Path, size):
        assert self.metadata[key]["generation"] == generation
        path.write_bytes(bytes(size))

    def write_result(self, key, value):
        if key in self.results:
            raise RuntimeError("Immutable result already exists")
        self.results[key] = deepcopy(value)
        self.metadata[key] = {"size": 100, "generation": 2, "content_type": "application/json"}

    def read_result(self, key):
        return deepcopy(self.results.get(key))

    def delete(self, key):
        self.deleted.append(key)
        self.metadata.pop(key, None)
        self.results.pop(key, None)


class MemoryTasks:
    def __init__(self):
        self.ids = set()
        self.fail_after_accepting = False

    def enqueue(self, job_id):
        self.ids.add(job_id)
        if self.fail_after_accepting:
            raise TimeoutError("Response lost after task created")

    def cancel(self, job_id):
        self.ids.discard(job_id)
