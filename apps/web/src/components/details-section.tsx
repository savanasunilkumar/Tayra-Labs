"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function DetailsSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group -ml-2.5 text-muted-foreground"
        >
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
