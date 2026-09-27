"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { ELANUS } from "@/lib/models";
import { DetailsSection } from "./details-section";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  api,
  message,
  sampleFile,
  terminal,
  validateVideo,
  videoTypes,
  type Job,
  type Pending,
  type Result,
} from "@/lib/api";
import {
  Plus,
  ChevronDown,
  Loader2,
  ArrowRight,
  ArrowUpRight,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { ResultView } from "./result-view";
import { accountStorageKey } from "@/lib/workspace-policy";

const DEFAULT_PROMPT =
  "Summarize the visual sequence in this video in at most three short sentences. Be concise.";
const presets = [
  { label: "Summarize", prompt: DEFAULT_PROMPT },
  {
    label: "Describe actions",
    prompt:
      "Describe the main actions and how they change over the course of this video. Be concise.",
  },
  {
    label: "Identify objects",
    prompt:
      "What objects and animals are visible? Only mention what you can clearly see.",
  },
];

export function Analyze() {
  const { session, health, remember, user } = useWorkspace();
  const PENDING = accountStorageKey("pending", user.id);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tokens, setTokens] = useState(256);
  const [duration, setDuration] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [isExample, setIsExample] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exampleBusy, setExampleBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
      if (
        value?.key &&
        value?.body?.asset_id &&
        typeof value.body.prompt === "string"
      ) {
        pendingRef.current = value;
        setPending(value);
        setPrompt(value.body.prompt);
        setTokens(value.body.max_new_tokens);
      }
    } catch {
      /* Optional submission recovery. */
    }
    return () => {
      alive.current = false;
    };
  }, [PENDING]);
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const object = URL.createObjectURL(file);
    setUrl(object);
    return () => URL.revokeObjectURL(object);
  }, [file]);
  function savePending(value: Pending | null) {
    pendingRef.current = value;
    setPending(value);
    try {
      if (value) sessionStorage.setItem(PENDING, JSON.stringify(value));
      else sessionStorage.removeItem(PENDING);
    } catch {
      /* Kept in memory if storage is unavailable. */
    }
  }
  const locked = busy || Boolean(pending);
  const tooLong = duration !== null && duration > 300;
  function choose(value?: File) {
    if (!value || locked) return;
    const problem = validateVideo(value);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setFile(value);
    setResult(null);
    setJob(null);
    setIsExample(false);
    setDuration(null);
    setPreviewError(false);
  }
  async function loadSample() {
    setExampleBusy(true);
    try {
      choose(await sampleFile());
    } catch (e) {
      setError(message(e));
    } finally {
      setExampleBusy(false);
    }
  }
  async function poll(initial: Job, label: string, token: string) {
    let current = initial;
    const deadline = Date.now() + 9300000;
    setJob(current);
    if (current.id !== session?.saved_job) remember(current, label);
    while (!terminal.has(current.status)) {
      if (!alive.current) return;
      if (Date.now() > deadline)
        throw new Error(
          "Polling stopped at the queue deadline. Open the existing job in Overview; do not submit a duplicate.",
        );
      setProgress(
        current.status === "running"
          ? "Analyzing your video"
          : current.status === "cancel_requested"
            ? "Cancellation requested"
            : "Your analysis is queued",
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!alive.current) return;
      current = (await api<{ job: Job }>(`jobs/${current.id}`, token)).job;
      setJob(current);
      if (current.id !== session?.saved_job) remember(current, label);
    }
    if (current.status !== "succeeded")
      throw new Error(
        current.error?.message ??
          `Analysis ${current.status.replaceAll("_", " ")}.`,
      );
    setProgress("Loading response");
    const output = await api<Result>(`jobs/${current.id}/result`, token);
    setResult(output);
    setProgress("");
  }
  async function run() {
    if (
      lock.current ||
      !session ||
      (!pendingRef.current &&
        (!file || !prompt.trim() || tooLong || !health?.analysis_enabled))
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setIsExample(false);
    setJob(null);
    let assetId: string | null = null;
    try {
      if (!pendingRef.current && file) {
        setProgress("Preparing upload");
        const { asset } = await api<{ asset: { id: string } }>(
          "assets",
          session.token,
          {
            method: "POST",
            body: JSON.stringify({
              filename: file.name,
              content_type:
                videoTypes[file.name.split(".").pop()!.toLowerCase()],
              size_bytes: file.size,
            }),
          },
        );
        assetId = asset.id;
        setProgress("Uploading video");
        await api(`assets/${asset.id}/content`, session.token, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        savePending({
          key: crypto.randomUUID(),
          label: file.name,
          body: {
            asset_id: asset.id,
            model: ELANUS.id,
            prompt: prompt.trim(),
            max_new_tokens: tokens,
          },
        });
      }
      const request = pendingRef.current!;
      setProgress("Submitting analysis");
      const { job: created } = await api<{ job: Job }>("jobs", session.token, {
        method: "POST",
        headers: { "Idempotency-Key": request.key },
        body: JSON.stringify(request.body),
      });
      remember(created, request.label);
      savePending(null);
      assetId = null;
      await poll(created, request.label, session.token);
    } catch (e) {
      if (assetId && !pendingRef.current) {
        try {
          await api(`assets/${assetId}`, session.token, { method: "DELETE" });
        } catch {
          /* Normal source retention remains the backstop. */
        }
      }
      setError(message(e));
      setProgress("");
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function openExample() {
    if (!session || lock.current || pendingRef.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress("Loading example");
    setFile(null);
    setDuration(null);
    setPreviewError(false);
    setJob(null);
    setPrompt(DEFAULT_PROMPT);
    setIsExample(true);
    try {
      const { job: existing } = await api<{ job: Job }>(
        `jobs/${session.saved_job}`,
        session.token,
      );
      if (session.sample_available) {
        try {
          setFile(await sampleFile());
        } catch {
          /* The response remains available without the source preview. */
        }
      }
      await poll(existing, "Penguins & places", session.token);
    } catch (e) {
      setError(message(e));
      setProgress("");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (!session || !job) return;
    setCancelling(true);
    setCancelOpen(false);
    try {
      const response = await api<{ job: Job }>(
        `jobs/${job.id}/cancel`,
        session.token,
        { method: "POST" },
      );
      setJob(response.job);
    } catch (e) {
      setError(message(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="analyze-layout">
      <section className="analyze-input" aria-label="Analysis inputs">
        <div className="input-fields">
          <div>
            <div className="field-heading">
              <h2>Video</h2>
              {file ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="quiet-action"
                  disabled={locked}
                  onClick={() => {
                    setFile(null);
                    setDuration(null);
                    setResult(null);
                    setIsExample(false);
                    if (input.current) input.current.value = "";
                  }}
                >
                  Remove
                </Button>
              ) : (
                session?.sample_available && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="quiet-action"
                    disabled={locked || exampleBusy}
                    onClick={() => void loadSample()}
                  >
                    {exampleBusy ? "Loading…" : "Use sample"}
                  </Button>
                )
              )}
            </div>
            <input
              ref={input}
              type="file"
              accept=".mp4,.mov,.webm"
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose video file"
              onChange={(e) => choose(e.target.files?.[0])}
            />
            {file ? (
              <>
                <video
                  className="video-preview"
                  controls
                  preload="metadata"
                  src={url || undefined}
                  onLoadedMetadata={(e) =>
                    setDuration(e.currentTarget.duration)
                  }
                  onError={() => setPreviewError(true)}
                  aria-label="Selected video preview"
                />
                <div className="video-caption">
                  <span title={file.name}>{file.name}</span>
                  <span>
                    {duration !== null && Number.isFinite(duration)
                      ? Math.round(duration) + "s · "
                      : ""}
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
                {previewError && (
                  <p className="settings-note">
                    This browser cannot preview the video. You can still submit
                    supported files.
                  </p>
                )}
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="video-drop"
                data-dragging={dragging}
                disabled={locked || exampleBusy}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!locked) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  choose(e.dataTransfer.files[0]);
                }}
              >
                <span
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <Plus size={13} />
                  Select video
                </span>
                <p>or drop a file here</p>
              </Button>
            )}
            {!file && (
              <div className="video-caption">
                <span>MP4, MOV, WebM</span>
                <span>Up to 5 min · 500 MiB</span>
              </div>
            )}
            {tooLong && (
              <p role="alert" className="inline-error">
                Choose a video no longer than 5 minutes.
              </p>
            )}
          </div>
          <div>
            <div className="field-heading">
              <label htmlFor="analysis-prompt">Prompt</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={locked}
                  >
                    Templates
                    <ChevronDown size={11} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {presets.map((preset) => (
                    <DropdownMenuItem
                      key={preset.label}
                      onSelect={() => setPrompt(preset.prompt)}
                    >
                      {preset.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Textarea
              id="analysis-prompt"
              className="prompt-editor"
              placeholder="What would you like to know about this video?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={locked}
              maxLength={4000}
            />
          </div>
          <DetailsSection
            title="Advanced settings"
            className="advanced-settings"
          >
            <div className="parameter-row">
              <span>Model</span>
              <span>{ELANUS.name}</span>
            </div>
            <div className="parameter-row">
              <label htmlFor="tokens">Maximum output tokens</label>
              <Select
                disabled={locked}
                value={String(tokens)}
                onValueChange={(value) => setTokens(Number(value))}
              >
                <SelectTrigger id="tokens" size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[128, 256, 512, 1024, 2048].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value.toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DetailsSection>
        </div>
        <div className="analyze-submit">
          {error && (
            <p role="alert" className="inline-error mb-3">
              {error}
            </p>
          )}
          {pending && (
            <p className="availability-note">
              Submission was interrupted. Retry the same request to recover its
              status without creating a duplicate.
            </p>
          )}
          {file && !pending && !health?.analysis_enabled && (
            <p className="availability-note">
              New analyses are currently unavailable. Your video has not been
              uploaded. <Link href="/settings">Connection details</Link>
            </p>
          )}
          <Button
            className="analyze-button"
            disabled={
              busy ||
              exampleBusy ||
              !session ||
              (!pending &&
                (!health?.analysis_enabled ||
                  !file ||
                  !prompt.trim() ||
                  tooLong))
            }
            onClick={() => void run()}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {busy ? "Working…" : pending ? "Retry request" : "Analyze"}
            {!busy && <ArrowRight size={14} />}
          </Button>
        </div>
      </section>
      <section className="analyze-output" aria-label="Analysis output">
        <div className="output-heading">
          <span>Response</span>
          <span className="example-label">
            {isExample
              ? "Reference example"
              : result
                ? "Completed"
                : busy
                  ? "In progress"
                  : ELANUS.name}
          </span>
        </div>
        {result ? (
          <ResultView result={result} />
        ) : busy ? (
          <div className="loading-output" role="status">
            <Loader2 size={20} className="animate-spin" />
            <h2>{progress}</h2>
            <p>
              {isExample ? (
                "Loading the reference response."
              ) : (
                <>
                  You can follow this request in{" "}
                  <Link
                    href="/overview"
                    className="underline underline-offset-4"
                  >
                    Overview
                  </Link>
                  .
                </>
              )}
            </p>
            {job && !terminal.has(job.status) && (
              <Button
                size="sm"
                variant="outline"
                disabled={cancelling || job.status === "cancel_requested"}
                onClick={() => setCancelOpen(true)}
              >
                {job.status === "cancel_requested"
                  ? "Cancellation requested"
                  : "Cancel analysis"}
              </Button>
            )}
          </div>
        ) : (
          <div className="output-empty">
            <div className="output-empty-inner">
              <h2>Ask more of your video.</h2>
              <p>
                Summarize a scene, follow an action, or find a detail. Start
                with a video and a question.
              </p>
              <div className="prompt-suggestions">
                {presets.map((preset, index) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    key={preset.label}
                    disabled={locked}
                    onClick={() => {
                      setPrompt(preset.prompt);
                      document.getElementById("analysis-prompt")?.focus();
                    }}
                  >
                    <span>
                      {
                        [
                          "Summarize what happens",
                          "Describe the actions in this video",
                          "Identify objects and animals",
                        ][index]
                      }
                    </span>
                    <ArrowRight size={14} />
                  </Button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="example-link"
                disabled={!session || locked || exampleBusy}
                onClick={() => void openExample()}
              >
                Open an example
                <ArrowUpRight size={12} />
              </Button>
            </div>
          </div>
        )}
        <div className="output-footnote">
          <span>Video understanding</span>
          <span>Text output</span>
        </div>
      </section>
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogTitle>Cancel this analysis?</DialogTitle>
          <DialogDescription>
            Running work may finish at a safe boundary and can still incur
            charges. This does not delete your video or result.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Keep running
            </Button>
            <Button onClick={() => void cancel()}>Request cancellation</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
