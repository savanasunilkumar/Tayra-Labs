"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ELANUS, modelName } from "@/lib/models";
import { DetailsSection } from "./details-section";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  api,
  copy,
  message,
  terminal,
  type Job,
  type Recent,
  type Result,
} from "@/lib/api";
import { analysisRows } from "@/lib/history";
import {
  Check,
  X,
  Loader2,
  Search,
  ListFilter,
  FileVideo,
  ChevronRight,
  Plus,
  ArrowRight,
  Copy,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { AccountSettings } from "./account-settings";
import { ResultView } from "./result-view";
import { Analyze } from "./analyze";

function Status({ status }: { status: string }) {
  return (
    <span className="status-label" data-status={status}>
      <span className="status-ring">
        {status === "succeeded" ? (
          <Check size={10} />
        ) : ["failed", "timed_out", "cancelled"].includes(status) ? (
          <X size={8} />
        ) : null}
      </span>
      {status === "succeeded" ? "Completed" : status.replaceAll("_", " ")}
    </span>
  );
}
function JobDialog({
  row,
  onClose,
}: {
  row: Recent | null;
  onClose: () => void;
}) {
  const { session, remember } = useWorkspace();
  const [result, setResult] = useState<Result | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!row || !session) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setResult(null);
    setError("");
    setJob(null);
    const load = async () => {
      try {
        const value = await api<{ job: Job }>(`jobs/${row.id}`, session.token);
        if (disposed) return;
        setJob(value.job);
        remember(value.job, row.label);
        if (value.job.status === "succeeded") {
          const output = await api<Result>(
            `jobs/${row.id}/result`,
            session.token,
          );
          if (!disposed) setResult(output);
        } else if (!terminal.has(value.job.status))
          timer = setTimeout(load, 4000);
      } catch (e) {
        if (!disposed) setError(message(e));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [row, session, remember]);
  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="result-dialog sm:max-w-2xl">
        <div className="result-dialog-header">
          <DialogTitle>{row?.label}</DialogTitle>
          <DialogDescription>Analysis details</DialogDescription>
        </div>
        {loading ? (
          <div role="status" className="loading-output">
            <Loader2 className="animate-spin" />
            <p>Loading analysis…</p>
          </div>
        ) : error ? (
          <p role="alert" className="inline-error p-6">
            {error}
          </p>
        ) : result ? (
          <ResultView result={result} />
        ) : (
          <div className="p-7">
            <Status status={job?.status ?? "unavailable"} />
            <p className="settings-note">
              {job?.error?.message ??
                (job && terminal.has(job.status)
                  ? "This analysis has no completed response."
                  : "Your analysis is in progress. This view updates automatically.")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
function Overview() {
  const { recent, session } = useWorkspace();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Recent | null>(null);
  const all = analysisRows(recent, { referenceJob: session?.saved_job });
  const rows = analysisRows(recent, {
    referenceJob: session?.saved_job,
    query,
    status,
  });
  const hasFilter = Boolean(query.trim()) || status !== "all";
  return (
    <div className="list-view">
      <div className="list-toolbar">
        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(value) => {
            if (value) setStatus(value);
          }}
          aria-label="Analysis status"
          size="sm"
          spacing={1}
        >
          {[
            ["all", "All analyses"],
            ["completed", "Completed"],
            ["active", "In progress"],
          ].map(([value, label]) => (
            <ToggleGroupItem value={value} key={value}>
              {label}
              {value === "all" && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {all.length}
                </span>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="list-controls">
          <label className="list-search">
            <Search size={14} />
            <Input
              className="h-8 w-44 pl-8"
              aria-label="Search analyses"
              placeholder="Search analyses…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="icon-control"
                aria-label="Filter analyses"
                title="Filter"
              >
                <ListFilter size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={status} onValueChange={setStatus}>
                <DropdownMenuRadioItem value="all">
                  All analyses
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="completed">
                  Completed
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="active">
                  In progress
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unsuccessful">
                  Unsuccessful
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table className="flat-table min-w-[650px]">
          <TableHeader>
            <TableRow>
              <TableHead className="name-cell">Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="analysis-name"
                    disabled={!session}
                    onClick={() => setSelected(row)}
                  >
                    <FileVideo size={15} />
                    <span>{row.label}</span>
                  </Button>
                </TableCell>
                <TableCell>
                  <Status status={row.status} />
                </TableCell>
                <TableCell>
                  {row.metrics?.video_seconds === undefined
                    ? "—"
                    : row.metrics.video_seconds + "s"}
                </TableCell>
                <TableCell>
                  {new Date(row.date).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="icon-control"
                    disabled={!session}
                    onClick={() => setSelected(row)}
                    aria-label={"Open " + row.label}
                  >
                    <ChevronRight size={13} />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length === 0 && (
        <div className="list-empty">
          <h2>
            {hasFilter
              ? "No matching analyses"
              : "Your first analysis starts here"}
          </h2>
          <p>
            {hasFilter
              ? "Try another search or change the status filter."
              : "Upload a video, ask a question, and turn what you see into something you can use."}
          </p>
          {hasFilter ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Clear filters
            </Button>
          ) : (
            <>
              <Button asChild size="sm" variant="outline">
                <Link href="/analyze">
                  <Plus />
                  New analysis
                </Link>
              </Button>
              <Button
                asChild
                size="sm"
                variant="link"
                className="empty-secondary text-muted-foreground"
              >
                <Link href="/reference">
                  Or start with the API <ArrowRight />
                </Link>
              </Button>
            </>
          )}
        </div>
      )}
      <div className="list-footer">
        {rows.length} {rows.length === 1 ? "analysis" : "analyses"}
        <Link href="/settings#history">History on this device</Link>
      </div>
      <JobDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
function Heading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="document-heading">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
function Details({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function Models() {
  return (
    <div className="page-document">
      <Heading
        title={ELANUS.name}
        description="The first release in the Elanus video understanding family."
      />
      <Details
        rows={[
          ["Model family", ELANUS.family],
          ["API model ID", ELANUS.id],
          ["Input", "Video"],
          ["Output", "Text"],
          ["Maximum video length", "5 minutes"],
          ["Maximum upload", "500 MiB"],
          ["Maximum output", "2,048 tokens"],
        ]}
      />
      <p className="model-description">
        Summarize visual sequences, describe actions, and ask questions about
        what appears in a video. Uses the full model checkpoint. Audio
        transcription is not included.
      </p>
      <DetailsSection title="Model provenance" className="request-details">
        <dl>
          <dt>Base model</dt>
          <dd>{ELANUS.checkpoint}</dd>
          <dt>Base provider</dt>
          <dd>{ELANUS.provider}</dd>
          <dt>Revision</dt>
          <dd>{ELANUS.revision}</dd>
        </dl>
        <p>
          Elanus is Tayra Labs’ served model release, powered by the full
          Molmo2-8B checkpoint. It is not a separately trained Tayra base model.
          The upstream checkpoint and revision remain available in response
          details.
        </p>
      </DetailsSection>
      <Button asChild size="sm" variant="outline" className="model-detail-link">
        <Link href="/analyze">
          Analyze a video
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [state, setState] = useState("");
  async function handle() {
    try {
      await copy(value);
      setState("Copied");
    } catch {
      setState("Copy unavailable");
    }
    setTimeout(() => setState(""), 2500);
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="quiet-action"
      onClick={() => void handle()}
      aria-live="polite"
    >
      {state === "Copied" ? <Check size={14} /> : <Copy size={14} />}
      {state || label}
    </Button>
  );
}
function Access() {
  return (
    <div className="page-document">
      <Heading
        title="API keys"
        description="Manage how your applications connect to Tayra Labs."
      />
      <Table className="key-table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Credential</TableHead>
            <TableHead>Managed by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>No API keys created</TableCell>
            <TableCell>—</TableCell>
            <TableCell>—</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <div className="settings-note">
        <p>
          Your workspace uses a secure account session. It does not share an
          administrator API key with other users.
        </p>
        <p>
          Self-service key creation and revocation are not available yet.
          Machine-to-machine API access will be configured separately from your
          login.
        </p>
      </div>
      <Button asChild size="sm" variant="outline" className="model-detail-link">
        <Link href="/reference">
          Authentication guide
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
const endpoints = [
  {
    label: "Register upload",
    method: "POST",
    path: "/v1/assets",
    description:
      "Register a video before upload. The response contains a short-lived signed URL and the headers required to upload your file.",
    body: '{"filename":"clip.mp4","content_type":"video/mp4","size_bytes":326478}',
  },
  {
    label: "Complete upload",
    method: "POST",
    path: "/v1/assets/$ASSET_ID/complete",
    description:
      "After uploading the video with a PUT request to its signed URL, mark the asset ready for analysis.",
    body: "",
  },
  {
    label: "Create analysis",
    method: "POST",
    path: "/v1/jobs",
    description:
      "Ask a question about a ready video. Analysis is asynchronous: the response returns a job ID you can use to retrieve progress and output.",
    body: '{"asset_id":"ASSET_ID","prompt":"Summarize the visual sequence.","max_new_tokens":256}',
  },
  {
    label: "Get status",
    method: "GET",
    path: "/v1/jobs/$JOB_ID",
    description:
      "Read the status of an analysis. Poll the existing job until it succeeds, fails, times out, or is cancelled.",
    body: "",
  },
  {
    label: "Get result",
    method: "GET",
    path: "/v1/jobs/$JOB_ID/result",
    description:
      "Retrieve a short-lived result URL after the analysis completes. Result JSON contains generated text, model provenance, and execution metrics.",
    body: "",
  },
  {
    label: "Cancel analysis",
    method: "POST",
    path: "/v1/jobs/$JOB_ID/cancel",
    description:
      "Request cancellation of an analysis. Running work may finish at a safe boundary and can still incur charges.",
    body: "",
  },
];
function Reference() {
  const { health, session } = useWorkspace();
  const baseUrl = session?.api_base_url ?? "Your account API base URL";
  const [index, setIndex] = useState(2);
  const endpoint = endpoints[index];
  // Keep copyable examples compatible with the currently deployed API.
  const supportsModel = health?.api_model_id === ELANUS.id;
  const requestBody =
    index === 2 && supportsModel
      ? JSON.stringify({ model: ELANUS.id, ...JSON.parse(endpoint.body) })
      : endpoint.body;
  const lines = [
    "curl -X " + endpoint.method + ' "$TAYRA_BASE_URL' + endpoint.path + '"',
    '  -H "Authorization: Bearer $TAYRA_ID_TOKEN"',
    ...(session?.api_iam
      ? ['  -H "X-Serverless-Authorization: Bearer $GOOGLE_ID_TOKEN"']
      : []),
    ...(endpoint.body
      ? [
          '  -H "Content-Type: application/json"',
          ...(index === 2 ? ['  -H "Idempotency-Key: $REQUEST_ID"'] : []),
          "  -d '" + requestBody + "'",
        ]
      : []),
  ];
  const snippet = lines.join(" \\\n");
  return (
    <div className="documentation-layout">
      <nav className="documentation-nav" aria-label="API endpoints">
        <p>API REFERENCE</p>
        {endpoints.map((item, i) => (
          <Button
            variant="ghost"
            size="sm"
            key={item.label}
            onClick={() => setIndex(i)}
            data-selected={i === index}
          >
            <span>{item.method}</span>
            {item.label}
          </Button>
        ))}
      </nav>
      <div className="documentation-main">
        <div className="endpoint-path">
          <span>{endpoint.method}</span>
          <code>{endpoint.path}</code>
        </div>
        <Heading title={endpoint.label} description={endpoint.description} />
        {index === 2 && (
          <p className="settings-note">
            Default model: {ELANUS.name} (<code>{ELANUS.id}</code>).
            {!supportsModel &&
              " The deployed endpoint currently uses this checkpoint automatically; this example omits model selection for compatibility."}
          </p>
        )}
        <div className="code-example">
          <div className="code-example-header">
            <span>cURL</span>
            <CopyButton value={snippet} />
          </div>
          <pre>{snippet}</pre>
        </div>
        <section className="settings-section">
          <h3 className="section-label">Authentication</h3>
          <p className="settings-note">
            Account API requests require a current Google Identity Platform ID
            token in the Authorization header. The workspace handles browser
            sessions for you. IAM-protected deployments also require a service
            identity in X-Serverless-Authorization. Personal API keys are not
            available yet.
          </p>
          <div className="base-url">
            <code>{baseUrl}</code>
            <CopyButton value={baseUrl} label="Copy URL" />
          </div>
        </section>
        <section className="settings-section">
          <h3 className="section-label">
            {index === 2 ? "Safe retries" : "Request workflow"}
          </h3>
          <p className="settings-note">
            {index === 2
              ? "Generate REQUEST_ID once per analysis. If a submission is interrupted, retry with the same idempotency key and identical request body. Replace ASSET_ID with your ready asset’s UUID."
              : "Register an asset, PUT the video bytes to its signed URL with the exact returned headers, complete the upload, then create an analysis. Retrieve the result when the job succeeds."}
          </p>
        </section>
      </div>
    </div>
  );
}
function Settings() {
  const { session, health, connect, connecting, connectionError } =
    useWorkspace();
  return (
    <div className="page-document">
      <Heading
        title="Workspace settings"
        description="Configuration and connection details for Tayra Labs."
      />
      <AccountSettings />
      <section className="settings-section">
        <h3 className="section-label">General</h3>
        <Details
          rows={[
            ["Workspace", "Tayra Labs"],
            ["Model", modelName(session?.model ?? ELANUS.id)],
            ["API model ID", ELANUS.id],
          ]}
        />
      </section>
      <section className="settings-section">
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-label mb-0!">Connection</h3>
          <Button
            variant="ghost"
            size="sm"
            className="quiet-action"
            onClick={() => void connect()}
            disabled={connecting}
          >
            {connecting ? "Checking…" : "Check connection"}
          </Button>
        </div>
        <Details
          rows={[
            ["API", health ? "Connected" : "Unavailable"],
            [
              "New analyses",
              !health
                ? "Unavailable"
                : health.analysis_enabled
                  ? "Available"
                  : "Paused",
            ],
            [
              "Google Cloud project",
              session?.project ?? "video-api-dev-509820",
            ],
            ["Region", "us-central1"],
            ["Access", "IAM-protected"],
          ]}
        />
        {connectionError && (
          <p role="alert" className="inline-error">
            {connectionError}
          </p>
        )}
        <p className="settings-note">
          Connection checks do not start compute. Workspace requests are
          authenticated on the server and scoped to your account.
        </p>
      </section>
      <section className="settings-section" id="history">
        <h3 className="section-label">Data & history</h3>
        <Details
          rows={[
            ["Source retention", "24 hours"],
            ["Result retention", "30 days"],
            ["Analysis history", "Your account"],
          ]}
        />
        <div className="settings-note">
          <p>
            Your recent analyses are synchronized from your account. A browser
            cache keeps recent filenames and statuses available while
            reconnecting.
          </p>
          <p>
            Retention cleanup is asynchronous. Credentials stay server-side.
          </p>
        </div>
      </section>
    </div>
  );
}
export function WorkspacePage({ section }: { section: string }) {
  if (section === "analyze") return <Analyze />;
  if (section === "overview") return <Overview />;
  if (section === "models") return <Models />;
  if (section === "access") return <Access />;
  if (section === "reference") return <Reference />;
  return <Settings />;
}
