"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copy, downloadResult, message, seconds, type Result } from "@/lib/api";
import { Download, Check, Copy } from "lucide-react";
import { modelName } from "@/lib/models";
import { DetailsSection } from "./details-section";

export function ResultView({ result }: { result: Result }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("response");
  async function copyResult() {
    try {
      await copy(
        tab === "json" ? JSON.stringify(result, null, 2) : result.output.text,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="response-tabs">
      <div className="response-toolbar">
        <TabsList>
          <TabsTrigger value="response">Text</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="icon-control"
            aria-label={copied ? "Copied result" : "Copy result"}
            title="Copy result"
            onClick={() => void copyResult()}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="icon-control"
            aria-label="Download result JSON"
            title="Download JSON"
            onClick={() => downloadResult(result)}
          >
            <Download size={14} />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="inline-error px-7">
          {error}
        </p>
      )}
      <TabsContent value="response" className="response-body">
        <p className="response-text">{result.output.text}</p>
        <div className="response-metadata">
          <span>{result.metrics.output_tokens ?? "—"} output tokens</span>
          <span>{seconds(result.metrics.gpu_execution_ms)} generation</span>
        </div>
        <DetailsSection title="Response details" className="request-details">
          <dl>
            <dt>Analysis ID</dt>
            <dd>{result.job_id}</dd>
            <dt>Model</dt>
            <dd>{modelName(result.model ?? result.model_id)}</dd>
            <dt>Checkpoint</dt>
            <dd>{result.model_id}</dd>
            <dt>Revision</dt>
            <dd>{result.model_revision}</dd>
            <dt>Video length</dt>
            <dd>
              {result.metrics.video_seconds === undefined
                ? "—"
                : result.metrics.video_seconds + "s"}
            </dd>
            <dt>Worker time</dt>
            <dd>{seconds(result.metrics.worker_ms)}</dd>
          </dl>
          <p>
            Execution times exclude upload and queueing. Review generated output
            for accuracy.
          </p>
        </DetailsSection>
      </TabsContent>
      <TabsContent value="json" className="response-body">
        <pre className="json-output">{JSON.stringify(result, null, 2)}</pre>
      </TabsContent>
    </Tabs>
  );
}
