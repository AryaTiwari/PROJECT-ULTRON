export type ViewMode = "home" | "command" | "mission" | "integrations" | "skills" | "outputs" | "system" | "about";

export interface BranchMetadata {
  sessionId: string;
  parentSessionId: string;
  anchorMessageId?: string | null;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionLike {
  id?: string;
  session_id?: string;
  title?: string;
  parent_id?: string | null;
  parent_session_id?: string | null;
  created_at?: string;
  updated_at?: string;
  branch_metadata?: BranchMetadata;
  status?: string;
  [key: string]: unknown;
}

export interface MissionEvidence {
  id: string;
  missionId?: string;
  kind: string;
  source: string;
  ref?: string | null;
  payload?: Record<string, unknown>;
  verified?: boolean;
  createdAt?: string;
}

export interface MissionEvent {
  id?: number;
  missionId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface MissionProgressStage {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "blocked";
  current?: number | null;
  target?: number | null;
  summary?: string | null;
}
export interface MissionProgress {
  currentStage: string;
  stages: MissionProgressStage[];
  currentItem?: string | null;
  completed: number;
  total?: number | null;
}
export interface Mission {
  id: string;
  objective: string;
  originalRequest?: string | null;
  status: string;
  state: Record<string, unknown>;
  constraints: Record<string, unknown>;
  completionCriteria: Record<string, unknown>;
  strategy: Record<string, unknown>;
  artifacts?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  progress?: MissionProgress;
  projectId?: string | null; repository?: string | null; branch?: string | null; worktree?: string | null; sessionId?: string | null; codingContext?: Record<string, unknown> | null;
  blockers?: Array<Record<string, unknown> | string>;
  approvals?: Array<Record<string, unknown>>;
  relatedSessions?: string[];
  childBranches?: string[];
  nextAction?: string | null;
  createdAt: string;
  updatedAt: string;
  evidence?: MissionEvidence[];
  events?: MissionEvent[];
}

export interface ModelRoute {
  id: string;
  role: string;
  configured: boolean;
  provider?: string | null;
  model?: string | null;
  cooling?: boolean;
  score?: number | null;
  metrics?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
  transport?: string | null;
  endpoint?: string | null;
}


export interface SkillDescriptor {
  id: string;
  name: string;
  summary: string;
  source: string;
  path?: string;
  available: boolean;
  category?: string; triggers?: string[]; inputs?: string[]; outputs?: string[]; approvalRequired?: boolean; owner?: string;
  description?: string; requiredParameters?: string[]; optionalParameters?: string[];
  parameters?: Record<string,{type:string;ownership:string;required?:boolean;default?:unknown}>;
  approvalClass?: string; costClass?: string; authentication?: string[]; sideEffect?: string;
  executor?: string; verifier?: string; recovery?: {mode?:string;maxAutomaticRetries?:number};
  compatibleUpstreamOutputs?: string[]; compatibleDownstreamInputs?: string[];
}

export interface IntelligencePattern {id:string;type:string;scope:string;projectId?:string|null;subject:string;description:string;value:unknown;confidence:number;evidenceCount:number;status:string;updatedAt:string;}
export interface IntelligenceSnapshot {patterns:IntelligencePattern[];purpose:{nodes:Array<Record<string,unknown>>;edges:Array<Record<string,unknown>>};memory:Array<Record<string,unknown>>;policy:Record<string,unknown>;}
export interface ReflexStatus {name:string;mode:string;dimensions:number;contractCount:number;cachedVectors:number;estimatedVectorMemoryMb:number;externalProcess:boolean;modelLoaded:boolean;metrics:Record<string,number>;}

export interface WorkspaceState {
  available: boolean;
  category?: string; triggers?: string[]; inputs?: string[]; outputs?: string[]; approvalRequired?: boolean; owner?: string;
  repository?: string;
  root?: string;
  branch?: string;
  head?: string;
  subject?: string;
  upstream?: string | null;
  dirty?: boolean;
  changes?: Array<{ code:string; path:string }>;
  recentCommits?: Array<{ hash:string; subject:string; relativeDate:string }>;
  worktrees?: Array<{ path:string; head:string; branch:string }>;
  error?: string;
}

export interface SystemOverview {
  generatedAt: string;
  workspace: WorkspaceState;
  skills: SkillDescriptor[];
  memory: { available:boolean; source?:string; excerpt?:string; updatedAt?:string; structuredCount?:number };
  purpose: { name:string; statement:string; source:string };
  outputs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  services: Array<{ id:string; label:string; status:string; detail:string }>;
  integrations?: IntegrationDescriptor[];
  intelligence?: IntelligenceSnapshot;
  reflex?: ReflexStatus;
  legacySkillInstructions?: number;
}
export interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt: string;
  previewUrl?: string;
}

export interface LiveEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
}

export type IntegrationStatus="CONNECTED"|"NOT_CONNECTED"|"AUTH_REQUIRED"|"INVALID"|"DEGRADED"|"RATE_LIMITED"|"UNAVAILABLE";
export interface IntegrationDescriptor{id:string;name:string;kind:string;status:IntegrationStatus;detail:string;configured:boolean;managed:boolean;capabilities:string[];scopes:string[];actions:string[];}
export interface AttentionItem{id:string;type:string;missionId?:string;integrationId?:string;title:string;detail:string;choices?:Array<{sheetId?:number;title:string}>;severity:string;action:string;}
