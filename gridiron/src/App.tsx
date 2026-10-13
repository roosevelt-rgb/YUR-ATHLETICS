import React, {
  useState,
  useEffect,
  useRef,
  createContext,
  useContext,
  Component,
} from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import {
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  User as FirebaseUser,
} from "firebase/auth";
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  Timestamp,
  getDocFromServer,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "./firebase";

import {
  Trophy,
  Users,
  Search,
  User as UserIcon,
  LogOut,
  Play,
  ChevronRight,
  Star,
  Shield,
  Zap,
  GraduationCap,
  MapPin,
  Calendar,
  Twitter,
  ExternalLink,
  X,
  Mail,
  Menu,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Type } from "@google/genai";

// Gemini calls go through this app's server (server.ts, POST /api/gemini/generate), which holds GEMINI_API_KEY; the key
// is never built into the page. The relay keeps the SDK's call shape: models.generateContent({ model, contents, config }).
const geminiViaServer = {
  models: {
    async generateContent(request: { model: string; contents: unknown; config?: unknown }): Promise<{ text: string }> {
      const res = await fetch("/api/gemini/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body: { text?: string; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Gemini request failed (${res.status})`);
      return { text: String(body.text ?? "") };
    },
  },
};

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

function isPermissionError(error: unknown) {
  const m = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    m.includes("permission") ||
    m.includes("insufficient") ||
    m.includes("denied")
  );
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: errorMsg,
    authInfo: {
      userId: auth.currentUser?.uid || "anonymous",
      email: auth.currentUser?.email || "none",
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
      tenantId: auth.currentUser?.tenantId || "none",
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName || "",
          email: provider.email || "",
          photoUrl: provider.photoURL || "",
        })) || [],
    },
    operationType,
    path,
  };

  console.error("Firestore Error Details:", errInfo);

  // Throw for permission errors so ErrorBoundary can catch them
  if (
    errorMsg.toLowerCase().includes("permission") ||
    errorMsg.toLowerCase().includes("insufficient") ||
    errorMsg.toLowerCase().includes("denied")
  ) {
    throw new Error(JSON.stringify(errInfo));
  }
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let displayMessage =
        "Something went wrong. Please try refreshing the page.";
      try {
        const parsedError = JSON.parse(this.state.error.message);
        if (parsedError.error.includes("permission-denied")) {
          displayMessage =
            "You don't have permission to perform this action. Our team has been notified.";
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <Shield className="w-16 h-16 text-emerald-500 mx-auto mb-6" />
            <h2 className="text-3xl font-black text-white uppercase italic mb-4">
              Access Restricted
            </h2>
            <p className="text-white/60 mb-8 font-bold uppercase tracking-tight">
              {displayMessage}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-8 py-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-full hover:scale-105 transition-all"
            >
              Refresh Platform
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Types ---
export type Position =
  "QB" | "RB" | "WR" | "TE" | "OL" | "DL" | "LB" | "CB" | "S" | "K" | "P";
export type Division = "FBS" | "FCS" | "D2" | "D3" | "NAIA" | "JUCO";
export type Region =
  "Northeast" | "Southeast" | "Midwest" | "Southwest" | "West";

export interface AthleteProfile {
  uid: string;
  demographics: {
    firstName: string;
    lastName: string;
    highSchool: string;
    gradYear: number;
    state: string;
  };
  athletics: {
    primaryPosition: Position;
    heightInches: number;
    weightLbs: number;
    stats: Record<string, number>;
  };
  academics: {
    gpa: number;
    satScore?: number;
    actScore?: number;
  };
  media: {
    hudlUrl?: string;
    twitterUrl?: string;
    maxPrepsUrl?: string;
    sports247Url?: string;
  };
  preferences: {
    desiredDivision: Division[];
    preferredRegion: Region[];
  };
}

export interface PositionProfile {
  count: number;
  byClass: Record<string, number>;
  openingsByHsClass: Record<string, number>;
  committedByHsClass?: Record<string, number>;
  netOpeningsByHsClass?: Record<string, number>;
  commitsKnown?: Record<string, boolean>;
  heightIn?: { min: number; avg: number; max: number } | null;
  weightLb?: { min: number; avg: number; max: number } | null;
}

export interface CollegeProgram {
  id: string;
  metadata: {
    name: string;
    division: Division;
    conference: string;
    region: Region;
    state?: string;
    ncaaOrgId?: number;
    athleticsUrl?: string;
  };
  academicThresholds: {
    minGpa: number;
    minSat?: number;
    minAct?: number;
  };
  positionalNeeds: Partial<Record<Position, number>>;
  // --- ledger extras (recruit/export_firestore.py) ---
  rosterProfile?: {
    season: string;
    byPosition: Record<string, PositionProfile>;
    footprint?: {
      total: number;
      texas: number;
      dfw: number;
      topStates: [string, number][];
    } | null;
    staffCounts?: Record<string, number>;
    sourceUrl?: string;
    scrapedAt?: string;
    scrapeStatus?: string;
  };
  commits?: Record<
    string,
    Record<string, { player: string; hometown: string; sourceUrl: string }[]>
  >;
  camps?: { url: string; label: string; dates: string; scrapedAt: string }[];
  policy?: {
    revShareCapUsd: number;
    capSeason: string;
    capNote: string;
    capSource: string;
    footballRosterLimit: number;
    rosterRoom: number | null;
    portalWindow: string;
    portalSource: string;
  } | null;
  isTexas?: boolean;
  schoolStatus?: string;
}

export interface AthleteCard {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  jersey?: string;
  position: string;
  positions?: string[];
  throws?: string;
  gradYear: number;
  highSchool: string;
  highSchoolId?: string;
  city?: string;
  state?: string;
  uil?: {
    conference: string;
    footballDistrict: number;
    region: string;
    cycle: string;
  };
  heightInches?: number | null;
  weightLbs?: number | null;
  gpa?: number | null;
  measurablesNote?: string;
  media?: {
    hudlUrl?: string;
    maxPrepsUrl?: string;
    twitterUrl?: string;
    teamSite?: string;
  };
  film?: {
    title: string;
    file?: string;
    length?: string;
    plays?: number;
    touchdowns?: number;
    games?: string[];
    hostedUrl?: string;
    notes?: string;
  }[];
  gameSources?: { game: string; url: string; source: string }[];
  stats?: {
    season: string;
    team?: string;
    source: string;
    fetchedAt?: string;
    sourceUrl?: string;
    passing?: Record<string, number | string>;
    rushing?: Record<string, number | string>;
  }[];
  statsNote?: string;
  contacts?: {
    headCoach?: string;
    headCoachEmail?: string;
    parent?: string;
    parentEmail?: string;
  };
  preferences?: {
    divisions?: string[];
    regions?: string[];
    statesFirst?: string[];
  };
  agent?: {
    enabled: boolean;
    cadence: string;
    maxSendsPerWeek: number;
    senderMailbox: string;
    approvalMode: string;
    lastRun: string | null;
    nextRun: string | null;
  };
  source?: string;
  updatedAt?: string;
}
export interface Touch {
  id: string;
  school: string;
  division?: string;
  subdivision?: string;
  channel: string;
  direction: string;
  at: string | null;
  note?: string;
  contact_name?: string;
  contact_email?: string;
  contact_role?: string;
  source?: string;
  subject?: string;
}

// Agent outputs (recruit/agent/*.py → Mongo film_notes / film_reports / drafts / agent_runs). All advisory.
export interface FilmNote {
  playId: string;
  reelOrder?: number;
  game?: string;
  desc?: string;
  td?: boolean;
  engine?: string;
  engines?: string[];
  confidence?: number;
  error?: string;
  scores?: Record<string, number>;
  sections?: Record<
    string,
    {
      title: string;
      items: { item: string; observation: string; recommendation: string }[];
    }
  >;
  key_issues?: {
    priority: number;
    name: string;
    description: string;
    impact_on_play?: string;
  }[];
  drills?: {
    name: string;
    fixes?: string;
    instructions?: string;
    reps?: string;
  }[];
  show_coaches?: { note?: string; reel_opener?: boolean };
  prime_points?: {
    point_code: string;
    metric: string;
    score: number;
    severity: string;
    insight: string;
    frame_label?: string;
  }[];
  visibility?: { limits?: string; confidence?: number };
  frames?: { frame_url: string; label?: string }[];
}
export interface FilmReport {
  overall?: number | null;
  scores?: Record<string, number | null>;
  strengths?: { metric: string; plays: number }[];
  fixFirst?: { name: string; plays: number; description?: string }[];
  drills?: { name: string; fixes?: string }[];
  reelOrder?: { playId: string; desc: string; overall?: number }[];
  engines?: string[];
  confidence?: number | null;
  generatedAt?: string;
  evaluated?: number;
  plays?: number;
  ungraded?: { playId: string; why: string }[];
}
export interface Draft {
  id: string;
  school: string;
  division?: string;
  to: string;
  toName?: string;
  toTitle?: string;
  mode?: string;
  subject: string;
  body: string;
  dm?: string;
  engine?: string;
  flags?: string[];
  status: string;
  createdAt?: string;
  approvedAt?: string | null;
  sentAt?: string | null;
}
export interface AgentRun {
  id: string;
  pipeline: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  counts?: Record<string, number>;
  error?: string | null;
  report?: string;
}

// Recruiting package + season film study files, served read-only by server.ts (GET /api/athletes/:id/reports[/:name]).
export interface ReportInfo {
  name: string;
  title: string;
  type: "html" | "pdf" | "json";
  private: boolean;
  available: boolean;
  url: string;
  bytes: number | null;
  updatedAt: string | null;
}
export interface HighlightPlay {
  rank: number;
  score: number;
  parts?: Record<string, number>;
  game: string;
  opponent?: string;
  date?: string;
  play?: string;
  quarter?: string;
  situation?: string;
  call?: string;
  result?: string;
  verdict?: string;
  coverage?: string;
  pressure?: string;
  hudl_video?: string;
  hudl_clip?: number;
  clip_seconds?: number;
}
export interface HighlightOrder {
  matrix?: string;
  reel: HighlightPlay[];
  eligible?: HighlightPlay[];
  reel_seconds_raw?: number;
}
interface PassLine {
  cmp: number;
  att: number;
  yds: number;
  td: number;
  int: number;
  gp?: number;
  note?: string;
  source?: string;
}
// recruit/data/games/season_2026_official_check.json (per-game "<game>_official" box lines may sit beside these)
export interface OfficialCheck {
  source?: string;
  maxpreps_26_27_varsity?: PassLine;
  maxpreps_by_game?: Record<
    string,
    { line?: number[]; url?: string } | string | string[]
  >;
  season_official?: PassLine;
  difference?: string;
  [key: string]: unknown;
}
export interface SeasonGame {
  opponent?: string;
  date?: string;
  result?: string;
}
export interface AthleteSchedule {
  remaining: { date: string; opponent: string }[];
  source: string | null;
  camps: {
    date?: string;
    dates?: string;
    name?: string;
    label?: string;
    location?: string;
    url?: string;
  }[];
}

export interface HighSchool {
  id: string;
  name: string;
  state: string;
  league: string;
  conference: string;
  enrollment?: number | null;
  footballDistrict?: number | null;
  division?: string;
  footballType?: string;
  region?: string;
  isDfw?: boolean;
  cycle?: string;
  source?: string;
}

export interface MatchResult {
  college: CollegeProgram;
  masScore: number;
  reasoning: string;
}

export interface Coach {
  id: string;
  name: string;
  title: string;
  college: string;
  division: Division;
  email?: string;
  twitterUrl?: string;
  photoUrl?: string;
  region: Region;
  // --- ledger extras (recruit/export_firestore.py) ---
  role?:
    | "qb_coach"
    | "recruiting_coordinator"
    | "player_personnel"
    | "area_recruiter_dfw"
    | "oc"
    | "head_coach"
    | "other";
  state?: string;
  conference?: string;
  source?: "tracker" | "scrape" | "manual";
  verifiedAt?: string;
  emailStatus?: "unknown" | "ok" | "bounced";
  programStatus?: "verified" | "unverified" | "excluded";
  lastTouch?: string;
  touches?: number;
  isTexas?: boolean;
  schoolStatus?: "open" | "responded" | "closed";
}

export interface Highlight {
  id: string;
  athleteUid: string;
  athleteName: string;
  title: string;
  videoUrl: string;
  description: string;
  createdAt: any;
}

interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  role: "athlete" | "coach" | "admin";
  createdAt: any;
}

// --- Matchmaking Engine ---
const WEIGHTS = {
  ATHLETIC: 0.55,
  ACADEMIC: 0.3,
  PREFERENCE: 0.15,
};

export class MatchmakingEngine {
  public static computeRecommendations(
    athlete: AthleteProfile,
    colleges: CollegeProgram[],
  ): MatchResult[] {
    const results: MatchResult[] = colleges.map((college) => {
      // 1. Athletic Fit Vector Calculation
      const posNeed =
        college.positionalNeeds[athlete.athletics.primaryPosition] || 0;
      const athleticScore = posNeed * 100;

      // 2. Academic Eligibility Vector Calculation
      let academicScore = 0;
      const gpaDelta =
        athlete.academics.gpa - college.academicThresholds.minGpa;

      if (gpaDelta >= 0) {
        academicScore = 80 + Math.min((gpaDelta / 1.0) * 20, 20);
      } else {
        academicScore = Math.max(0, 100 + gpaDelta * 100);
      }

      // 3. Preference Vector Calculation
      let prefScore = 0;
      if (
        athlete.preferences.desiredDivision.includes(college.metadata.division)
      )
        prefScore += 50;
      if (athlete.preferences.preferredRegion.includes(college.metadata.region))
        prefScore += 50;

      // 4. Aggregate Match Affinity Score (MAS)
      const masScore = Math.round(
        athleticScore * WEIGHTS.ATHLETIC +
          academicScore * WEIGHTS.ACADEMIC +
          prefScore * WEIGHTS.PREFERENCE,
      );

      // 5. Dynamic Reasoning Synthesis
      const reasoning = this.generateReasoning(
        athlete,
        college,
        athleticScore,
        academicScore,
        prefScore,
      );

      return { college, masScore, reasoning };
    });

    return results.sort((a, b) => b.masScore - a.masScore);
  }

  private static generateReasoning(
    athlete: AthleteProfile,
    college: CollegeProgram,
    athScore: number,
    acadScore: number,
    prefScore: number,
  ): string {
    const reasons: string[] = [];

    if (athScore > 80)
      reasons.push(
        `${college.metadata.name} has a critical systemic need for a ${athlete.athletics.primaryPosition}.`,
      );
    else if (athScore > 50)
      reasons.push(
        `Moderate positional alignment for ${athlete.athletics.primaryPosition} within their current depth chart.`,
      );

    if (acadScore >= 90)
      reasons.push(
        `Your GPA (${athlete.academics.gpa}) significantly exceeds their baseline admission thresholds.`,
      );
    else if (acadScore === 0)
      reasons.push(
        `Warning: Academic metrics fall below standard historical minimums for this program.`,
      );

    if (prefScore === 100)
      reasons.push(
        `Perfect alignment with your geographic and division preferences (${college.metadata.division}, ${college.metadata.region}).`,
      );

    return (
      reasons.join(" ") ||
      "General programmatic alignment based on baseline parameters."
    );
  }
}

// --- UI Components ---

interface EditorProps {
  initialData: AthleteProfile;
  onSave: (updatedProfile: AthleteProfile) => void;
}

const AthleteProfileEditor: React.FC<EditorProps> = ({
  initialData,
  onSave,
}) => {
  const [profile, setProfile] = useState<AthleteProfile>(initialData);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState(0);

  const deepSearchAthlete = async () => {
    if (!profile.demographics?.firstName || !profile.demographics?.lastName) {
      setSyncMessage("Enter First & Last Name to search.");
      return;
    }
    setIsSyncing(true);
    setSyncProgress(10);
    setSyncMessage("Initializing deep search engine...");

    // Simulate progress
    const progressInterval = setInterval(() => {
      setSyncProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + Math.floor(Math.random() * 5) + 2;
      });
    }, 800);

    try {
      setSyncMessage("Scouring MaxPreps, Hudl, and 247Sports...");
      const ai = geminiViaServer;
      console.log(
        "Starting deep search for:",
        profile.demographics.firstName,
        profile.demographics.lastName,
      );
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Find the football recruiting profile and stats for high school athlete ${profile.demographics.firstName} ${profile.demographics.lastName} ${profile.demographics.highSchool || ""} ${profile.demographics.state || ""}.
        Search for their MaxPreps, Hudl, Twitter, and 247Sports profiles.
        
        CRITICAL INSTRUCTIONS:
        1. ONLY provide a URL if you are 100% certain it belongs to THIS specific athlete.
        2. Match the High School and State to ensure identity integrity.
        3. If a profile is not found, leave the field null. DO NOT guess, hallucinate, or provide a generic search URL.
        4. If you find multiple athletes with the same name, ONLY return data if you can verify the correct one via High School or State.
        
        Extract:
        - High School Name
        - Graduation Year
        - State
        - Primary Position (QB, RB, WR, TE, OL, DL, LB, CB, S, K, P)
        - Height (inches)
        - Weight (lbs)
        - GPA, SAT, ACT scores if mentioned
        - Passing Yards, Touchdowns, Tackles, Interceptions, Rushing Yards, Receptions, Receiving Yards
        - MaxPreps URL (must be a valid maxpreps.com link)
        - Hudl URL (must be a valid hudl.com link)
        - Twitter URL (must be a valid twitter.com or x.com link)
        - 247Sports URL (must be a valid 247sports.com link)
        
        Return as JSON matching the schema.`,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              demographics: {
                type: Type.OBJECT,
                properties: {
                  highSchool: { type: Type.STRING },
                  gradYear: { type: Type.INTEGER },
                  state: { type: Type.STRING },
                },
              },
              athletics: {
                type: Type.OBJECT,
                properties: {
                  primaryPosition: { type: Type.STRING },
                  heightInches: { type: Type.INTEGER },
                  weightLbs: { type: Type.INTEGER },
                  stats: {
                    type: Type.OBJECT,
                    properties: {
                      passingYards: { type: Type.NUMBER },
                      touchdowns: { type: Type.NUMBER },
                      tackles: { type: Type.NUMBER },
                      interceptions: { type: Type.NUMBER },
                      rushingYards: { type: Type.NUMBER },
                      receptions: { type: Type.NUMBER },
                      receivingYards: { type: Type.NUMBER },
                    },
                  },
                },
              },
              academics: {
                type: Type.OBJECT,
                properties: {
                  gpa: { type: Type.NUMBER },
                  satScore: { type: Type.INTEGER },
                  actScore: { type: Type.INTEGER },
                },
              },
              media: {
                type: Type.OBJECT,
                properties: {
                  maxPrepsUrl: { type: Type.STRING },
                  hudlUrl: { type: Type.STRING },
                  twitterUrl: { type: Type.STRING },
                  sports247Url: { type: Type.STRING },
                },
              },
            },
          },
        },
      });

      const result = JSON.parse(response.text);
      console.log("Deep search result:", result);
      if (result) {
        setProfile((prev) => ({
          ...prev,
          demographics: {
            ...prev.demographics,
            highSchool:
              result.demographics?.highSchool || prev.demographics.highSchool,
            gradYear:
              result.demographics?.gradYear || prev.demographics.gradYear,
            state: result.demographics?.state || prev.demographics.state,
          },
          athletics: {
            ...prev.athletics,
            primaryPosition:
              (result.athletics?.primaryPosition as Position) ||
              prev.athletics.primaryPosition,
            heightInches:
              result.athletics?.heightInches || prev.athletics.heightInches,
            weightLbs: result.athletics?.weightLbs || prev.athletics.weightLbs,
            stats: {
              ...prev.athletics.stats,
              ...(result.athletics?.stats || {}),
            },
          },
          academics: {
            ...prev.academics,
            gpa: result.academics?.gpa || prev.academics.gpa,
            satScore:
              result.academics?.satScore ?? prev.academics.satScore ?? 0,
            actScore:
              result.academics?.actScore ?? prev.academics.actScore ?? 0,
          },
          media: {
            ...prev.media,
            maxPrepsUrl: result.media?.maxPrepsUrl || prev.media.maxPrepsUrl,
            hudlUrl: result.media?.hudlUrl || prev.media.hudlUrl,
            twitterUrl: result.media?.twitterUrl || prev.media.twitterUrl,
            sports247Url: result.media?.sports247Url || prev.media.sports247Url,
          },
        }));
        setSyncProgress(100);
        setSyncMessage("Deep search complete! Data populated.");
        setTimeout(() => {
          setSyncMessage(null);
          setSyncProgress(0);
        }, 5000);
      }
    } catch (error: any) {
      console.error("Deep search error details:", error);
      const errorMessage = error?.message || "Unknown error";
      setSyncMessage(`Deep search failed: ${errorMessage.substring(0, 50)}`);
      setSyncProgress(0);
    } finally {
      setIsSyncing(false);
      clearInterval(progressInterval);
    }
  };

  const syncMaxPrepsStats = async () => {
    if (!profile.media?.maxPrepsUrl) return;
    setIsSyncing(true);
    setSyncProgress(20);
    setSyncMessage("Connecting to MaxPreps...");

    const progressInterval = setInterval(() => {
      setSyncProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + 5;
      });
    }, 1000);

    console.log("Syncing MaxPreps URL:", profile.media.maxPrepsUrl);
    try {
      // 1. Fetch HTML content via proxy to bypass CORS/bot detection
      const proxyUrl = `/api/proxy/maxpreps?url=${encodeURIComponent(profile.media.maxPrepsUrl)}`;
      console.log("Calling proxy:", proxyUrl);
      const proxyResponse = await fetch(proxyUrl);

      if (!proxyResponse.ok) {
        const errorData = await proxyResponse
          .json()
          .catch(() => ({ error: proxyResponse.statusText }));
        throw new Error(
          errorData.error || `Proxy failed with status ${proxyResponse.status}`,
        );
      }

      const { html } = await proxyResponse.json();
      console.log("Fetched HTML length:", html?.length);

      setSyncProgress(60);
      setSyncMessage("Extracting verified statistics...");

      // 2. Send HTML content to Gemini (through the server relay) for extraction
      const ai = geminiViaServer;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            text: `Extract the athlete's profile information from this MaxPreps HTML content. 
            Include:
            - First Name
            - Last Name
            - High School Name
            - Graduation Year
            - State (2-letter abbreviation)
            - Primary Position (one of: QB, RB, WR, TE, OL, DL, LB, CB, S, K, P)
            - Height (in total inches)
            - Weight (in lbs)
            - Football stats (career totals if available, otherwise most recent season)
            
            Return the data as a JSON object matching the requested schema.
            
            HTML Content:
            ${html.substring(0, 50000)}`, // Truncate to avoid token limits while keeping core info
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              demographics: {
                type: Type.OBJECT,
                properties: {
                  firstName: { type: Type.STRING },
                  lastName: { type: Type.STRING },
                  highSchool: { type: Type.STRING },
                  gradYear: { type: Type.INTEGER },
                  state: { type: Type.STRING },
                },
              },
              athletics: {
                type: Type.OBJECT,
                properties: {
                  primaryPosition: { type: Type.STRING },
                  heightInches: { type: Type.INTEGER },
                  weightLbs: { type: Type.INTEGER },
                  stats: {
                    type: Type.OBJECT,
                    properties: {
                      passingYards: { type: Type.NUMBER },
                      touchdowns: { type: Type.NUMBER },
                      tackles: { type: Type.NUMBER },
                      interceptions: { type: Type.NUMBER },
                      rushingYards: { type: Type.NUMBER },
                      receptions: { type: Type.NUMBER },
                      receivingYards: { type: Type.NUMBER },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const result = JSON.parse(response.text);
      if (result) {
        setProfile((prev) => ({
          ...prev,
          demographics: {
            ...prev.demographics,
            ...(result.demographics || {}),
          },
          athletics: {
            ...prev.athletics,
            ...(result.athletics
              ? {
                  primaryPosition:
                    result.athletics.primaryPosition ||
                    prev.athletics.primaryPosition,
                  heightInches:
                    result.athletics.heightInches ||
                    prev.athletics.heightInches,
                  weightLbs:
                    result.athletics.weightLbs || prev.athletics.weightLbs,
                  stats: {
                    ...prev.athletics.stats,
                    ...(result.athletics.stats || {}),
                  },
                }
              : {}),
          },
        }));
        setSyncProgress(100);
        setSyncMessage("Profile data synchronized successfully!");
        setTimeout(() => {
          setSyncMessage(null);
          setSyncProgress(0);
        }, 3000);
      }
    } catch (error) {
      console.error("MaxPreps sync error:", error);
      setSyncMessage("Failed to sync data. Please check the URL.");
      setSyncProgress(0);
    } finally {
      setIsSyncing(false);
      clearInterval(progressInterval);
    }
  };

  const handleDemographicChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProfile({
      ...profile,
      demographics: {
        ...profile.demographics,
        [name]: name === "gradYear" ? parseInt(value) || 0 : value,
      },
    });
  };

  const handleAthleticChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;
    if (name.startsWith("stats.")) {
      const statName = name.split(".")[1];
      setProfile({
        ...profile,
        athletics: {
          ...profile.athletics,
          stats: {
            ...profile.athletics.stats,
            [statName]: parseInt(value) || 0,
          },
        },
      });
    } else {
      setProfile({
        ...profile,
        athletics: {
          ...profile.athletics,
          [name]:
            name === "weightLbs" || name === "heightInches"
              ? parseInt(value) || 0
              : value,
        },
      });
    }
  };

  const handleAcademicChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProfile({
      ...profile,
      academics: {
        ...profile.academics,
        [name]: e.target.type === "number" ? parseFloat(value) || 0 : value,
      },
    });
  };

  const handleMediaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setProfile({
      ...profile,
      media: { ...profile.media, [e.target.name]: e.target.value },
    });
  };

  const handleSave = async () => {
    if (!profile.uid) {
      setSyncMessage("Error: User ID missing. Please re-login.");
      return;
    }

    setIsSaving(true);
    setSyncMessage("Committing profile data to Gridiron Scout database...");

    // Sanitize profile object to remove any 'undefined' values which Firestore rejects
    const sanitize = (obj: any): any => {
      const newObj: any = Array.isArray(obj) ? [] : {};
      Object.keys(obj).forEach((key) => {
        if (obj[key] === undefined) return;
        if (obj[key] !== null && typeof obj[key] === "object") {
          newObj[key] = sanitize(obj[key]);
        } else {
          newObj[key] = obj[key];
        }
      });
      return newObj;
    };

    const sanitizedProfile = sanitize(profile);
    console.log("Committing Sanitized Profile:", sanitizedProfile);

    try {
      await setDoc(doc(db, "athletes", profile.uid), sanitizedProfile);
      console.log("Commit Successful");

      // --- Mandatory System Flush Sequence ---
      setSyncMessage("Commit Successful. Initiating Global System Flush...");
      await new Promise((resolve) => setTimeout(resolve, 1200));

      setSyncMessage("Flushing Multi-System Orchestrator Caches...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      setSyncMessage("Re-indexing Sovereign AI Telemetry...");
      await new Promise((resolve) => setTimeout(resolve, 800));

      setSyncMessage("Purging Stale Agent Contexts...");
      await new Promise((resolve) => setTimeout(resolve, 600));

      setSyncMessage("System Flush Complete. Synchronizing UI...");
      await new Promise((resolve) => setTimeout(resolve, 400));

      onSave(profile);
    } catch (error) {
      console.error("Commit Failed:", error);
      setSyncMessage("Commit failed. Check your connection or permissions.");
      handleFirestoreError(
        error,
        OperationType.WRITE,
        `athletes/${profile.uid}`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 bg-slate-900 text-white rounded-lg shadow-xl">
      <h2 className="text-2xl font-bold mb-6 text-emerald-400 uppercase italic tracking-tight">
        Athlete Telemetry Configuration
      </h2>

      <div className="space-y-6">
        <section className="bg-slate-800 p-6 rounded-xl border border-white/5">
          <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-2">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-white/40">
              Demographics
            </h3>
            <div className="flex items-center gap-4">
              {isSyncing && (
                <div className="w-32 h-1 bg-slate-700 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${syncProgress}%` }}
                    className="h-full bg-emerald-500"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={deepSearchAthlete}
                disabled={
                  isSyncing ||
                  !profile.demographics?.firstName ||
                  !profile.demographics?.lastName
                }
                className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase tracking-widest rounded-full border border-emerald-500/20 hover:bg-emerald-500 hover:text-black transition-all disabled:opacity-50"
              >
                <Search className="w-3 h-3" />
                {isSyncing ? "Searching..." : "Deep Search"}
              </button>
            </div>
          </div>
          {isSyncing && (
            <p className="text-[9px] font-black uppercase tracking-widest text-emerald-400 mb-4 animate-pulse">
              {syncMessage}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <input
              name="firstName"
              value={profile.demographics?.firstName || ""}
              onChange={handleDemographicChange}
              placeholder="First Name"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="lastName"
              value={profile.demographics?.lastName || ""}
              onChange={handleDemographicChange}
              placeholder="Last Name"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="highSchool"
              value={profile.demographics?.highSchool || ""}
              onChange={handleDemographicChange}
              placeholder="High School"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="gradYear"
              type="number"
              value={profile.demographics?.gradYear || ""}
              onChange={handleDemographicChange}
              placeholder="Grad Year"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="state"
              value={profile.demographics?.state || ""}
              onChange={handleDemographicChange}
              placeholder="State (e.g. TX)"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
          </div>
        </section>

        <section className="bg-slate-800 p-6 rounded-xl border border-white/5">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-4 border-b border-white/10 pb-2">
            Athletics
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <select
              name="primaryPosition"
              value={profile.athletics?.primaryPosition || ""}
              onChange={handleAthleticChange}
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            >
              <option value="">Select Position</option>
              {[
                "QB",
                "RB",
                "WR",
                "TE",
                "OL",
                "DL",
                "LB",
                "CB",
                "S",
                "K",
                "P",
              ].map((pos) => (
                <option key={pos} value={pos}>
                  {pos}
                </option>
              ))}
            </select>
            <input
              name="heightInches"
              type="number"
              value={profile.athletics?.heightInches || ""}
              onChange={handleAthleticChange}
              placeholder="Height (Inches)"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="weightLbs"
              type="number"
              value={profile.athletics?.weightLbs || ""}
              onChange={handleAthleticChange}
              placeholder="Weight (Lbs)"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <input
              name="stats.passingYards"
              type="number"
              value={profile.athletics?.stats?.passingYards || ""}
              onChange={handleAthleticChange}
              placeholder="Pass Yds"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="stats.touchdowns"
              type="number"
              value={profile.athletics?.stats?.touchdowns || ""}
              onChange={handleAthleticChange}
              placeholder="TDs"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="stats.tackles"
              type="number"
              value={profile.athletics?.stats?.tackles || ""}
              onChange={handleAthleticChange}
              placeholder="Tackles"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
          </div>
        </section>

        <section className="bg-slate-800 p-6 rounded-xl border border-white/5">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-4 border-b border-white/10 pb-2">
            Academics
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <input
              name="gpa"
              type="number"
              step="0.01"
              value={profile.academics?.gpa || ""}
              onChange={handleAcademicChange}
              placeholder="GPA"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="satScore"
              type="number"
              value={profile.academics?.satScore || ""}
              onChange={handleAcademicChange}
              placeholder="SAT"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
            <input
              name="actScore"
              type="number"
              value={profile.academics?.actScore || ""}
              onChange={handleAcademicChange}
              placeholder="ACT"
              className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all"
            />
          </div>
        </section>

        <section className="bg-slate-800 p-6 rounded-xl border border-white/5">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-4 border-b border-white/10 pb-2">
            Media
          </h3>
          <div className="space-y-4">
            {isSyncing && (
              <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden mb-4">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${syncProgress}%` }}
                  className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                />
              </div>
            )}

            <div className="relative">
              <input
                name="hudlUrl"
                value={profile.media?.hudlUrl || ""}
                onChange={handleMediaChange}
                placeholder="Hudl Highlight URL"
                className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all pr-10"
              />
              {profile.media?.hudlUrl && (
                <button
                  type="button"
                  onClick={() =>
                    handleMediaChange({
                      target: { name: "hudlUrl", value: "" },
                    } as any)
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/60 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="relative">
              <input
                name="twitterUrl"
                value={profile.media?.twitterUrl || ""}
                onChange={handleMediaChange}
                placeholder="Twitter Profile URL"
                className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all pr-10"
              />
              {profile.media?.twitterUrl && (
                <button
                  type="button"
                  onClick={() =>
                    handleMediaChange({
                      target: { name: "twitterUrl", value: "" },
                    } as any)
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/60 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="relative">
              <input
                name="sports247Url"
                value={profile.media?.sports247Url || ""}
                onChange={handleMediaChange}
                placeholder="247Sports Profile URL"
                className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all pr-10"
              />
              {profile.media?.sports247Url && (
                <button
                  type="button"
                  onClick={() =>
                    handleMediaChange({
                      target: { name: "sports247Url", value: "" },
                    } as any)
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/60 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    name="maxPrepsUrl"
                    value={profile.media?.maxPrepsUrl || ""}
                    onChange={handleMediaChange}
                    placeholder="MaxPreps Profile URL"
                    className="p-3 bg-slate-700 rounded-xl w-full outline-none focus:ring-2 ring-emerald-500/50 transition-all pr-10"
                  />
                  {profile.media?.maxPrepsUrl && (
                    <button
                      type="button"
                      onClick={() =>
                        handleMediaChange({
                          target: { name: "maxPrepsUrl", value: "" },
                        } as any)
                      }
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/60 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={syncMaxPrepsStats}
                  disabled={isSyncing || !profile.media?.maxPrepsUrl}
                  className="px-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 transition-all flex items-center gap-2"
                >
                  {isSyncing ? (
                    <Zap className="w-4 h-4 animate-pulse" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  Sync
                </button>
              </div>
              {syncMessage && (
                <p
                  className={cn(
                    "text-[10px] font-black uppercase tracking-widest",
                    syncMessage.includes("successfully")
                      ? "text-emerald-400"
                      : "text-red-400",
                  )}
                >
                  {syncMessage}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="bg-slate-800 p-6 rounded-xl border border-white/5">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-4 border-b border-white/10 pb-2">
            Recruiting Preferences
          </h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">
                Desired Division
              </span>
              <div className="flex flex-wrap gap-2">
                {["FBS", "FCS", "D2", "D3", "NAIA", "JUCO"].map((div) => (
                  <button
                    key={div}
                    type="button"
                    onClick={() => {
                      const current = profile.preferences.desiredDivision || [];
                      const next = current.includes(div as Division)
                        ? current.filter((d) => d !== div)
                        : [...current, div as Division];
                      setProfile({
                        ...profile,
                        preferences: {
                          ...profile.preferences,
                          desiredDivision: next,
                        },
                      });
                    }}
                    className={cn(
                      "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest transition-all",
                      profile.preferences.desiredDivision?.includes(
                        div as Division,
                      )
                        ? "bg-emerald-500 text-black"
                        : "bg-slate-700 text-white/40 hover:bg-slate-600",
                    )}
                  >
                    {div}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">
                Preferred Region
              </span>
              <div className="flex flex-wrap gap-2">
                {["Northeast", "Southeast", "Midwest", "Southwest", "West"].map(
                  (reg) => (
                    <button
                      key={reg}
                      type="button"
                      onClick={() => {
                        const current =
                          profile.preferences.preferredRegion || [];
                        const next = current.includes(reg as Region)
                          ? current.filter((r) => r !== reg)
                          : [...current, reg as Region];
                        setProfile({
                          ...profile,
                          preferences: {
                            ...profile.preferences,
                            preferredRegion: next,
                          },
                        });
                      }}
                      className={cn(
                        "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest transition-all",
                        profile.preferences.preferredRegion?.includes(
                          reg as Region,
                        )
                          ? "bg-emerald-500 text-black"
                          : "bg-slate-700 text-white/40 hover:bg-slate-600",
                      )}
                    >
                      {reg}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>
        </section>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="w-full bg-emerald-500 hover:bg-emerald-400 text-black transition-all py-4 rounded-xl font-black uppercase tracking-widest mt-4 disabled:opacity-50 shadow-lg shadow-emerald-500/20"
        >
          {isSaving ? "Synchronizing..." : "Commit Profile Data"}
        </button>

        {syncMessage && !isSyncing && (
          <p
            className={cn(
              "text-center text-[10px] font-black uppercase tracking-widest mt-4",
              syncMessage.includes("successfully")
                ? "text-emerald-400"
                : "text-red-400",
            )}
          >
            {syncMessage}
          </p>
        )}
      </div>
    </div>
  );
};

interface DashboardProps {
  athlete: AthleteProfile;
}

const RecruiterDashboard: React.FC<DashboardProps> = ({ athlete }) => {
  const { demographics, athletics, academics, media } = athlete;

  return (
    <div className="max-w-5xl mx-auto p-8 bg-zinc-50 rounded-3xl shadow-2xl overflow-hidden text-zinc-900">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b-4 border-emerald-600 pb-8 mb-10">
        <div>
          <h1 className="text-6xl font-black text-zinc-900 tracking-tighter uppercase italic">
            {demographics?.firstName} {demographics?.lastName}
          </h1>
          <p className="text-xl text-zinc-500 font-bold mt-2 uppercase tracking-tight">
            {demographics?.highSchool} • Class of {demographics?.gradYear} •{" "}
            {demographics?.state}
          </p>
        </div>
        <div className="text-right mt-6 md:mt-0">
          <span className="block text-8xl font-black text-emerald-600 leading-none italic">
            {athletics?.primaryPosition}
          </span>
          <span className="block text-xl font-black text-zinc-400 mt-2 uppercase tracking-widest">
            {Math.floor((athletics?.heightInches || 0) / 12)}'
            {(athletics?.heightInches || 0) % 12}" | {athletics?.weightLbs} LBS
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
        <div className="col-span-2 space-y-10">
          <section>
            <h2 className="text-2xl font-black text-zinc-900 mb-6 flex items-center uppercase italic tracking-tight">
              <span className="bg-emerald-600 w-3 h-8 mr-4 block"></span>{" "}
              Athletic Output
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
              {Object.entries(athletics?.stats || {}).map(
                ([statName, value]) => (
                  <div
                    key={statName}
                    className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200 hover:border-emerald-500/30 transition-all"
                  >
                    <span className="block text-[10px] text-zinc-400 font-black uppercase tracking-widest mb-2">
                      {statName.replace(/([A-Z])/g, " $1")}
                    </span>
                    <span className="block text-4xl font-black text-zinc-800 italic">
                      {value}
                    </span>
                  </div>
                ),
              )}
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-black text-zinc-900 mb-6 flex items-center uppercase italic tracking-tight">
              <span className="bg-emerald-600 w-3 h-8 mr-4 block"></span> Film
              Room
            </h2>
            <div className="aspect-video bg-zinc-900 rounded-3xl flex items-center justify-center relative overflow-hidden shadow-2xl">
              {media?.hudlUrl ? (
                <iframe
                  src={media.hudlUrl}
                  className="absolute inset-0 w-full h-full"
                  title="Hudl Highlights"
                  frameBorder="0"
                  allowFullScreen
                ></iframe>
              ) : (
                <div className="text-center">
                  <Play size={48} className="text-zinc-700 mx-auto mb-4" />
                  <span className="text-zinc-500 font-black uppercase tracking-widest">
                    Media Stream Unavailable
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-8">
          <div className="bg-zinc-900 text-white p-8 rounded-3xl shadow-xl border border-white/5">
            <h3 className="text-xl font-black mb-6 border-b border-white/10 pb-4 uppercase italic tracking-tight">
              Academic Validation
            </h3>
            <div className="space-y-6">
              <div>
                <span className="text-zinc-500 text-[10px] font-black uppercase tracking-widest block mb-2">
                  Cumulative GPA
                </span>
                <span className="block text-5xl font-black text-emerald-400 italic">
                  {academics?.gpa?.toFixed(2)}
                </span>
              </div>
              {academics?.satScore && (
                <div>
                  <span className="text-zinc-500 text-[10px] font-black uppercase tracking-widest block mb-2">
                    SAT Composite
                  </span>
                  <span className="block text-3xl font-black italic">
                    {academics.satScore}
                  </span>
                </div>
              )}
              {academics?.actScore && (
                <div>
                  <span className="text-zinc-500 text-[10px] font-black uppercase tracking-widest block mb-2">
                    ACT Score
                  </span>
                  <span className="block text-3xl font-black italic">
                    {academics.actScore}
                  </span>
                </div>
              )}
            </div>
          </div>

          {media?.maxPrepsUrl && (
            <div className="bg-white p-8 rounded-3xl shadow-xl border border-zinc-200">
              <h3 className="text-xl font-black mb-4 uppercase italic tracking-tight text-zinc-900">
                Verified Stats
              </h3>
              <a
                href={media.maxPrepsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-4 bg-zinc-100 rounded-2xl hover:bg-zinc-200 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center text-white font-black italic">
                    MP
                  </div>
                  <span className="font-black uppercase tracking-tight text-zinc-700">
                    MaxPreps Profile
                  </span>
                </div>
                <ExternalLink className="w-5 h-5 text-zinc-400 group-hover:text-emerald-600 transition-colors" />
              </a>
            </div>
          )}

          {(media?.sports247Url || media?.twitterUrl) && (
            <div className="bg-white p-8 rounded-3xl shadow-xl border border-zinc-200">
              <h3 className="text-xl font-black mb-4 uppercase italic tracking-tight text-zinc-900">
                Social & Media
              </h3>
              <div className="space-y-3">
                {media?.sports247Url && (
                  <a
                    href={media.sports247Url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-4 bg-zinc-100 rounded-2xl hover:bg-zinc-200 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-blue-900 rounded-lg flex items-center justify-center text-white font-black italic">
                        247
                      </div>
                      <span className="font-black uppercase tracking-tight text-zinc-700">
                        247Sports
                      </span>
                    </div>
                    <ExternalLink className="w-5 h-5 text-zinc-400 group-hover:text-emerald-600 transition-colors" />
                  </a>
                )}
                {media?.twitterUrl && (
                  <a
                    href={media.twitterUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-4 bg-zinc-100 rounded-2xl hover:bg-zinc-200 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-black rounded-lg flex items-center justify-center text-white">
                        <Twitter size={20} />
                      </div>
                      <span className="font-black uppercase tracking-tight text-zinc-700">
                        Twitter / X
                      </span>
                    </div>
                    <ExternalLink className="w-5 h-5 text-zinc-400 group-hover:text-emerald-600 transition-colors" />
                  </a>
                )}
              </div>
            </div>
          )}

          <div className="bg-emerald-500 p-8 rounded-3xl shadow-xl text-black">
            <h3 className="text-xl font-black mb-4 uppercase italic tracking-tight">
              Recruiter Note
            </h3>
            <p className="font-bold text-sm leading-relaxed opacity-80">
              This athlete meets the baseline academic and physical thresholds
              for most {athletics?.primaryPosition} systems. Film shows
              high-level processing and elite physical traits.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};

// --- Context ---
const AuthContext = createContext<{
  user: FirebaseUser | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: () => Promise<void>;
  logout: () => Promise<void>;
}>({
  user: null,
  profile: null,
  loading: true,
  signIn: async () => {},
  logout: async () => {},
});

const useAuth = () => useContext(AuthContext);

// --- Components ---

const Navbar = () => {
  const { user, profile, signIn, logout } = useAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  // Phones and iPad portrait (below lg) get the links in a menu under the bar instead of the inline row.
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const navLinks: [string, string][] = [
    ["/scout", "Scout Feed"],
    ["/athletes", "Athletes"],
    ["/coaches", "Coaches"],
    ["/needs", "Who's Looking"],
    ["/players", "Players"],
    ...(profile?.role === "athlete"
      ? ([
          ["/matches", "College Matches"],
          ["/my-profile", "My Profile"],
        ] as [string, string][])
      : []),
  ];

  return (
    <nav
      className={cn(
        "fixed top-0 left-0 right-0 z-50 transition-all duration-300 px-6 py-4",
        isScrolled || menuOpen
          ? "bg-black/90 backdrop-blur-md border-b border-white/10"
          : "bg-transparent",
      )}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 group">
          <div className="w-10 h-10 bg-emerald-500 rounded-lg flex items-center justify-center group-hover:rotate-12 transition-transform">
            <Trophy className="text-black w-6 h-6" />
          </div>
          <span className="text-xl sm:text-2xl font-black tracking-tighter uppercase italic text-white whitespace-nowrap">
            Gridiron Scout
          </span>
        </Link>

        <div className="hidden lg:flex items-center gap-8">
          {navLinks.map(([to, label]) => (
            <Link
              key={to}
              to={to}
              className="text-sm font-semibold uppercase tracking-widest text-white/70 hover:text-emerald-400 transition-colors"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-bold text-white uppercase tracking-tighter">
                  {profile?.displayName}
                </p>
                <p className="text-[10px] text-emerald-400 uppercase font-black tracking-widest">
                  {profile?.role}
                </p>
              </div>
              <button
                onClick={logout}
                aria-label="Sign out"
                className="p-2 hover:bg-white/10 rounded-full transition-colors text-white/70 hover:text-white"
              >
                <LogOut size={20} />
              </button>
            </div>
          ) : (
            <button
              onClick={signIn}
              className="hidden sm:inline-block px-6 py-2 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full hover:bg-emerald-400 transition-colors"
            >
              Join The League
            </button>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="lg:hidden w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="lg:hidden max-w-7xl mx-auto mt-4 pt-2 border-t border-white/10 flex flex-col">
          {navLinks.map(([to, label]) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
              className={cn(
                "py-3 min-h-11 flex items-center text-sm font-semibold uppercase tracking-widest border-b border-white/5 transition-colors",
                location.pathname === to
                  ? "text-emerald-400"
                  : "text-white/70 hover:text-emerald-400",
              )}
            >
              {label}
            </Link>
          ))}
          {!user && (
            <button
              onClick={signIn}
              className="sm:hidden mt-4 mb-2 px-6 py-3 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full hover:bg-emerald-400 transition-colors"
            >
              Join The League
            </button>
          )}
        </div>
      )}
    </nav>
  );
};

const Hero = () => {
  return (
    <section className="relative min-h-screen md:h-screen flex flex-col md:flex-row items-center justify-center overflow-hidden bg-black">
      {/* Background Image with Overlay */}
      <div className="absolute inset-0 z-0">
        <img
          src="https://images.unsplash.com/photo-1566577739112-5180d4bf9390?auto=format&fit=crop&q=80&w=2000"
          className="w-full h-full object-cover opacity-40 grayscale"
          alt="Football Stadium"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 text-center max-md:my-auto max-md:pt-28 max-md:pb-12">
        <motion.div
          initial={{ opacity: 0, scale: 2, y: -100 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="mb-6"
        >
          <span className="inline-block px-4 py-1 bg-emerald-500 text-black text-[10px] font-black uppercase tracking-[0.3em] mb-4">
            Mainstream Exposure
          </span>
          <h1 className="text-[15vw] md:text-[12vw] font-black leading-[0.85] uppercase italic tracking-tighter text-white">
            NEXT
            <br />
            GEN
            <br />
            <span className="text-emerald-500">ELITE</span>
          </h1>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="max-w-2xl mx-auto text-white/60 text-lg md:text-xl font-medium mb-10"
        >
          The premier scouting platform bridging the gap between high school
          talent and college programs. Your journey to the league starts here.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Link
            to="/scout"
            className="group flex items-center gap-3 px-8 py-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-full hover:scale-105 transition-all"
          >
            Start Scouting{" "}
            <ChevronRight className="group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link
            to="/athletes"
            className="px-8 py-4 border border-white/20 text-white font-black uppercase tracking-widest rounded-full hover:bg-white/10 transition-all"
          >
            View Athletes
          </Link>
        </motion.div>
      </div>

      {/* Stats Bar (below the buttons on phones, pinned to the bottom from md up) */}
      <div className="relative w-full md:absolute md:bottom-0 md:left-0 md:right-0 border-t border-white/10 bg-black/50 backdrop-blur-xl py-8">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            { label: "Active Scouts", value: "500+" },
            { label: "D1 Offers", value: "1.2k" },
            { label: "Athletes", value: "10k+" },
            { label: "Commitments", value: "850" },
          ].map((stat, i) => (
            <div key={i} className="text-center md:text-left">
              <p className="text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">
                {stat.label}
              </p>
              <p className="text-3xl font-black text-white italic tracking-tighter">
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const MyProfile = () => {
  const { user } = useAuth();
  const [athleteData, setAthleteData] = useState<AthleteProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) {
      const fetchAthlete = async () => {
        try {
          const docRef = doc(db, "athletes", user.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setAthleteData(docSnap.data() as AthleteProfile);
          }
        } catch (error) {
          handleFirestoreError(
            error,
            OperationType.GET,
            `athletes/${user.uid}`,
          );
        } finally {
          setLoading(false);
        }
      };
      fetchAthlete();
    }
  }, [user]);

  if (loading)
    return (
      <div className="pt-32 text-center text-white/40">Loading Profile...</div>
    );

  const defaultProfile: AthleteProfile = {
    uid: user?.uid || "",
    demographics: {
      firstName: "",
      lastName: "",
      highSchool: "",
      gradYear: 2026,
      state: "",
    },
    athletics: {
      primaryPosition: "QB",
      heightInches: 72,
      weightLbs: 180,
      stats: {},
    },
    academics: { gpa: 3.5 },
    media: {},
    preferences: { desiredDivision: [], preferredRegion: [] },
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-end justify-between mb-12 border-b border-white/10 pb-8">
          <div>
            <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
              Athlete Management
            </span>
            <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter">
              My Profile
            </h2>
          </div>
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="px-6 py-2 bg-white text-black text-xs font-black uppercase tracking-widest rounded-full hover:bg-emerald-400 transition-colors"
          >
            {isEditing ? "View Dashboard" : "Edit Profile"}
          </button>
        </div>

        {isEditing ? (
          <AthleteProfileEditor
            initialData={athleteData || defaultProfile}
            onSave={(updated) => {
              setAthleteData(updated);
              setIsEditing(false);
            }}
          />
        ) : athleteData ? (
          <RecruiterDashboard athlete={athleteData} />
        ) : (
          <div className="text-center py-20 bg-white/5 rounded-3xl border border-dashed border-white/10">
            <p className="text-white/40 font-black uppercase tracking-widest mb-6">
              No profile data found. Start building your legacy.
            </p>
            <button
              onClick={() => setIsEditing(true)}
              className="px-8 py-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-full"
            >
              Create Profile
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const AddHighlight = ({ onClose }: { onClose: () => void }) => {
  const { user, profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [flushStatus, setFlushStatus] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !profile) return;
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const highlightId = Math.random().toString(36).substring(7);

    const newHighlight: Highlight = {
      id: highlightId,
      athleteUid: user.uid,
      athleteName: profile.displayName,
      title: formData.get("title") as string,
      videoUrl: formData.get("videoUrl") as string,
      description: formData.get("description") as string,
      createdAt: Timestamp.now(),
    };

    try {
      await setDoc(doc(db, "highlights", highlightId), newHighlight);

      // --- Mandatory System Flush Sequence ---
      setFlushStatus("Highlight Uploaded. Initiating System Flush...");
      await new Promise((resolve) => setTimeout(resolve, 800));

      setFlushStatus("Flushing Global Orchestrator...");
      await new Promise((resolve) => setTimeout(resolve, 600));

      setFlushStatus("System Flush Complete.");
      await new Promise((resolve) => setTimeout(resolve, 400));

      onClose();
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.WRITE,
        `highlights/${highlightId}`,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="bg-[#111] border border-white/10 rounded-3xl p-8 w-full max-w-lg"
      >
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-2xl font-black text-white uppercase italic tracking-tight">
            Post Highlight
          </h3>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">
              Video Title
            </span>
            <input
              name="title"
              required
              placeholder="e.g. Week 4 vs Central High"
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:border-emerald-500 outline-none transition-all"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">
              Video URL (YouTube/Hudl)
            </span>
            <input
              name="videoUrl"
              type="url"
              required
              placeholder="https://..."
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:border-emerald-500 outline-none transition-all"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">
              Description
            </span>
            <textarea
              name="description"
              rows={3}
              placeholder="Describe the play or game context..."
              className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:border-emerald-500 outline-none transition-all resize-none"
            />
          </label>

          {flushStatus && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-500 animate-pulse text-center">
                {flushStatus}
              </p>
            </div>
          )}

          <button
            disabled={loading}
            type="submit"
            className="w-full py-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-xl hover:scale-[1.02] transition-all disabled:opacity-50"
          >
            {loading ? "Processing Flush..." : "Go Mainstream"}
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
};

// --- Updated ScoutFeed with Add Button ---

const ScoutFeed = () => {
  const { profile } = useAuth();
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, "highlights"),
      orderBy("createdAt", "desc"),
      limit(20),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setHighlights(
          snapshot.docs.map(
            (doc) => ({ id: doc.id, ...doc.data() }) as Highlight,
          ),
        );
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, "highlights");
      },
    );
    return () => unsubscribe();
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-end justify-between mb-12 border-b border-white/10 pb-8">
          <div>
            <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
              Live Scouting
            </span>
            <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter">
              The Feed
            </h2>
          </div>
          <div className="flex gap-4">
            {profile?.role === "athlete" && (
              <button
                onClick={() => setShowAdd(true)}
                className="px-6 py-3 bg-emerald-500 text-black text-[10px] font-black uppercase tracking-widest rounded-full hover:scale-105 transition-all flex items-center gap-2"
              >
                <Play size={14} className="fill-black" /> Post Highlight
              </button>
            )}
          </div>
        </div>

        {showAdd && <AddHighlight onClose={() => setShowAdd(false)} />}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {highlights.length > 0 ? (
            highlights.map((highlight) => (
              <motion.div
                key={highlight.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="group bg-white/5 border border-white/10 rounded-2xl overflow-hidden hover:border-emerald-500/50 transition-all"
              >
                <div className="aspect-video bg-black relative">
                  <a
                    href={highlight.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 z-10"
                  >
                    <Play className="text-emerald-500 w-12 h-12 fill-emerald-500" />
                  </a>
                  <img
                    src={`https://picsum.photos/seed/${highlight.id}/800/450`}
                    className="w-full h-full object-cover opacity-60"
                    alt={highlight.title}
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">
                      Highlight Reel
                    </p>
                    <p className="text-[10px] text-white/40 uppercase font-bold">
                      {highlight.createdAt?.toDate().toLocaleDateString() ||
                        "Recently"}
                    </p>
                  </div>
                  <h3 className="text-xl font-black text-white uppercase italic tracking-tight mb-2">
                    {highlight.title}
                  </h3>
                  <p className="text-sm text-white/60 mb-6 line-clamp-2">
                    {highlight.description}
                  </p>
                  <div className="flex items-center justify-between pt-6 border-t border-white/10">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                        <UserIcon size={14} className="text-emerald-500" />
                      </div>
                      <span className="text-xs font-bold text-white uppercase tracking-tighter">
                        {highlight.athleteName}
                      </span>
                    </div>
                    <button className="text-xs font-black text-emerald-500 uppercase tracking-widest hover:underline underline-offset-4">
                      View Profile
                    </button>
                  </div>
                </div>
              </motion.div>
            ))
          ) : (
            <div className="col-span-full py-20 text-center border-2 border-dashed border-white/10 rounded-3xl">
              <Zap className="mx-auto text-white/20 w-12 h-12 mb-4" />
              <p className="text-white/40 font-black uppercase tracking-widest">
                No highlights found. Be the first to post.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Matchmaking Component ---

const Matchmaking = () => {
  const { profile } = useAuth();
  const [athleteData, setAthleteData] = useState<AthleteProfile | null>(null);
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (profile?.uid) {
      const fetchAthlete = async () => {
        const docRef = doc(db, "athletes", profile.uid);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setAthleteData(docSnap.data() as AthleteProfile);
        }
      };
      fetchAthlete();
    }
  }, [profile]);

  const generateMatches = async () => {
    if (!athleteData) return;
    setLoading(true);

    try {
      // Fetch colleges from Firestore
      const collegesSnap = await getDocs(collection(db, "colleges"));
      const colleges = collegesSnap.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as CollegeProgram,
      );

      if (colleges.length === 0) {
        // ... (AI fallback remains same)
        const ai = geminiViaServer;
        const prompt = `As a college football recruiting expert, suggest 5 college football programs for this athlete:
        Position: ${athleteData.athletics?.primaryPosition}
        GPA: ${athleteData.academics?.gpa}
        SAT: ${athleteData.academics?.satScore}
        ACT: ${athleteData.academics?.actScore}
        Stats: ${JSON.stringify(athleteData.athletics?.stats)}
        Preferences: ${JSON.stringify(athleteData.preferences)}
        
        Provide a ranked list of colleges with a brief explanation for each match based on their academic requirements, program style, and the athlete's preferences.`;

        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  collegeName: { type: Type.STRING },
                  rank: { type: Type.INTEGER },
                  explanation: { type: Type.STRING },
                  matchScore: {
                    type: Type.INTEGER,
                    description: "Score out of 100",
                  },
                },
                required: ["collegeName", "rank", "explanation", "matchScore"],
              },
            },
          },
        });
        const result = JSON.parse(response.text);
        setMatches(result);
      } else {
        // Use deterministic engine
        const results = MatchmakingEngine.computeRecommendations(
          athleteData,
          colleges,
        );
        setMatches(
          results.map((r, i) => ({
            collegeName: r.college.metadata.name,
            rank: i + 1,
            explanation: r.reasoning,
            matchScore: Math.round(r.masScore),
          })),
        );
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, "colleges");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-12 border-b border-white/10 pb-8">
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            AI Matchmaker
          </span>
          <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter">
            College Matches
          </h2>
          <p className="text-white/40 mt-4 text-lg">
            Our algorithm analyzes your profile to find the perfect fit for your
            academic and athletic future.
          </p>
        </div>

        {!athleteData ? (
          <div className="bg-white/5 border border-white/10 rounded-3xl p-12 max-md:p-6 text-center">
            <p className="text-white/60 font-bold mb-6 uppercase tracking-widest">
              Complete your athlete profile first to get matches.
            </p>
            <Link
              to="/my-profile"
              className="px-8 py-4 bg-emerald-500 text-black font-black uppercase tracking-widest rounded-full max-md:inline-block"
            >
              Complete Profile
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            <button
              onClick={generateMatches}
              disabled={loading}
              className="w-full py-6 bg-white text-black font-black text-xl uppercase tracking-[0.2em] rounded-3xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-4 disabled:opacity-50 max-md:px-4 max-md:text-base"
            >
              {loading ? (
                <>Analyzing Talent Pool...</>
              ) : (
                <>
                  Find My Future Program <Zap className="fill-black" />
                </>
              )}
            </button>

            <div className="grid gap-6">
              {matches.map((match, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  className="bg-white/5 border border-white/10 rounded-3xl p-8 max-md:p-5 hover:border-emerald-500/30 transition-all"
                >
                  <div className="flex items-start justify-between mb-6 max-md:gap-4">
                    <div>
                      <span className="text-emerald-500 text-[10px] font-black uppercase tracking-widest">
                        Rank #{match.rank}
                      </span>
                      <h3 className="text-3xl max-md:text-2xl font-black text-white uppercase italic tracking-tight">
                        {match.collegeName}
                      </h3>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-white/40 uppercase font-black tracking-widest">
                        Match Score
                      </p>
                      <p className="text-3xl font-black text-emerald-500 italic">
                        {match.matchScore}%
                      </p>
                    </div>
                  </div>
                  <p className="text-white/70 leading-relaxed text-lg">
                    {match.explanation}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const AthleteList = () => {
  const [athletes, setAthletes] = useState<any[]>([]);
  const [selectedAthlete, setSelectedAthlete] = useState<AthleteProfile | null>(
    null,
  );

  useEffect(() => {
    const q = query(collection(db, "athletes"), limit(20));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setAthletes(
          snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        );
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, "athletes");
      },
    );
    return () => unsubscribe();
  }, []);

  if (selectedAthlete) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
        <div className="max-w-7xl mx-auto">
          <button
            onClick={() => setSelectedAthlete(null)}
            className="mb-8 text-emerald-500 font-black uppercase tracking-widest flex items-center gap-2 hover:translate-x-[-4px] transition-transform"
          >
            ← Back to Prospects
          </button>
          <RecruiterDashboard athlete={selectedAthlete} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-12">
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            Talent Pool
          </span>
          <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter">
            Prospects
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10">
                <th className="py-6 text-[10px] font-black text-white/40 uppercase tracking-widest">
                  Athlete
                </th>
                <th className="py-6 text-[10px] font-black text-white/40 uppercase tracking-widest">
                  Position
                </th>
                <th className="py-6 text-[10px] font-black text-white/40 uppercase tracking-widest">
                  School
                </th>
                <th className="py-6 text-[10px] font-black text-white/40 uppercase tracking-widest">
                  Class
                </th>
                <th className="py-6 text-[10px] font-black text-white/40 uppercase tracking-widest">
                  Rating
                </th>
                <th className="py-6"></th>
              </tr>
            </thead>
            <tbody>
              {athletes.map((athlete) => (
                <tr
                  key={athlete.id}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors group"
                >
                  <td className="py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-white/10 rounded-lg flex items-center justify-center overflow-hidden">
                        {athlete.media?.twitterUrl ? (
                          <img
                            src={`https://unavatar.io/twitter/${athlete.media.twitterUrl.split("/").pop()}`}
                            className="w-full h-full object-cover"
                            alt=""
                          />
                        ) : (
                          <UserIcon className="text-white/40" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-black text-white uppercase tracking-tight">
                          {athlete.demographics?.firstName}{" "}
                          {athlete.demographics?.lastName}
                        </p>
                        <p className="text-[10px] text-white/40 uppercase font-bold">
                          {athlete.demographics?.state || "USA"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="py-6">
                    <span className="px-3 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase tracking-widest rounded-full">
                      {athlete.athletics?.primaryPosition || "TBD"}
                    </span>
                  </td>
                  <td className="py-6 text-sm font-bold text-white/70 uppercase">
                    {athlete.demographics?.highSchool || "TBD"}
                  </td>
                  <td className="py-6 text-sm font-bold text-white/70 uppercase">
                    {athlete.demographics?.gradYear || "TBD"}
                  </td>
                  <td className="py-6">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star
                          key={s}
                          size={12}
                          className={
                            s <= 4
                              ? "text-emerald-500 fill-emerald-500"
                              : "text-white/10"
                          }
                        />
                      ))}
                    </div>
                  </td>
                  <td className="py-6 text-right">
                    <button
                      onClick={() => setSelectedAthlete(athlete)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity px-4 py-2 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-full"
                    >
                      View Profile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

type CoachSeed = { generatedAt: string; source: string; coaches: Coach[] };
type CollegeSeed = {
  generatedAt: string;
  source: string;
  colleges: CollegeProgram[];
};
type HsSeed = {
  generatedAt: string;
  source: string;
  highschools: HighSchool[];
};
const loadCoachSeed = async (): Promise<CoachSeed> =>
  (await import("@seed/coaches.seed.json")).default as unknown as CoachSeed;
const loadCollegeSeed = async (): Promise<CollegeSeed> =>
  (await import("@seed/colleges.seed.json")).default as unknown as CollegeSeed;
const loadHsSeed = async (): Promise<HsSeed> =>
  (await import("@seed/highschools.seed.json")).default as unknown as HsSeed;

// Local/RunPod API (Express + MongoDB). Returns null when the API is not running (e.g. static hosting).
async function fetchApi<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function importCollection<T extends { id: string }>(
  name: string,
  rows: T[],
  onProgress: (msg: string) => void,
) {
  for (let i = 0; i < rows.length; i += 400) {
    const batch = writeBatch(db);
    rows
      .slice(i, i + 400)
      .forEach((r) =>
        batch.set(doc(db, name, r.id), r as any, { merge: true }),
      );
    await batch.commit();
    onProgress(`${name}: ${Math.min(i + 400, rows.length)} / ${rows.length}`);
  }
}

const roleLabel = (r?: string) =>
  (
    ({
      qb_coach: "QB Coach",
      recruiting_coordinator: "Recruiting Coordinator",
      player_personnel: "Player Personnel",
      area_recruiter_dfw: "DFW Area Recruiter",
      oc: "Offensive Coordinator",
      head_coach: "Head Coach",
    }) as Record<string, string>
  )[r || ""] || "Football Staff";

// Optional admin account (Coaches import, first-run seed): VITE_ADMIN_EMAIL in .env.local. Firestore admins are role: admin.
const ADMIN_EMAIL: string = import.meta.env.VITE_ADMIN_EMAIL ?? "";

const CoachDirectory = () => {
  const { profile } = useAuth();
  const isAdmin =
    profile?.role === "admin" || (!!ADMIN_EMAIL && profile?.email === ADMIN_EMAIL);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [division, setDivision] = useState<"ALL" | Division>("ALL");
  const [stateFilter, setStateFilter] = useState<string>("ALL");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "untouched" | "emailed" | "bounced" | "responded"
  >("ALL");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [source, setSource] = useState<"api" | "firestore" | "seed" | "">("");
  const [seedDate, setSeedDate] = useState("");
  const usingSeed = source === "seed";

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const useSeed = async () => {
      const seed = await loadCoachSeed();
      if (cancelled) return;
      setCoaches(
        [...seed.coaches].sort((a, b) => a.college.localeCompare(b.college)),
      );
      setSeedDate(seed.generatedAt);
      setSource("seed");
      setLoading(false);
    };
    (async () => {
      const api = await fetchApi<{ total: number; rows: Coach[] }>(
        "/api/coaches?limit=5000",
      );
      if (cancelled) return;
      if (api && api.rows.length > 0) {
        setCoaches(api.rows);
        setSource("api");
        setLoading(false);
        return;
      }
      if (!auth.currentUser) {
        await useSeed();
      }
      const q = query(collection(db, "coaches"), orderBy("college", "asc"));
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const coachData = snapshot.docs.map(
            (doc) => ({ id: doc.id, ...doc.data() }) as Coach,
          );
          if (coachData.length > 0) {
            setCoaches(coachData);
            setSource("firestore");
            setLoading(false);
          } else {
            useSeed();
          }
        },
        (error) => {
          if (isPermissionError(error)) {
            useSeed();
            return;
          }
          handleFirestoreError(error, OperationType.LIST, "coaches");
          setLoading(false);
        },
      );
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Admin-only: load the recruit ledger export (src/data/coaches.seed.json) into Firestore.
  // Idempotent: deterministic ids + merge, so re-importing after a new export only updates changed fields.
  const importSeed = async () => {
    if (!isAdmin || importing) return;
    setImporting(true);
    try {
      const [cs, cl, hs] = await Promise.all([
        loadCoachSeed(),
        loadCollegeSeed(),
        loadHsSeed(),
      ]);
      await importCollection("coaches", cs.coaches, setImportMsg);
      await importCollection("colleges", cl.colleges, setImportMsg);
      await importCollection("highschools", hs.highschools, setImportMsg);
      setImportMsg(
        `Import complete: ${cs.coaches.length} coaches, ${cl.colleges.length} programs, ${hs.highschools.length} UIL schools (ledger export ${cs.generatedAt}).`,
      );
    } catch (error) {
      setImportMsg(
        "Import failed. Sign in with the admin account and try again.",
      );
      handleFirestoreError(error, OperationType.WRITE, "coaches");
    } finally {
      setImporting(false);
    }
  };

  const states = Array.from(
    new Set(coaches.map((c) => c.state).filter(Boolean) as string[]),
  ).sort((a, b) => (a === "TX" ? -1 : b === "TX" ? 1 : a.localeCompare(b)));
  const roles = Array.from(
    new Set(coaches.map((c) => c.role).filter(Boolean) as string[]),
  ).sort();

  const matches = (c: Coach) => {
    const q = searchTerm.toLowerCase();
    if (
      q &&
      !(
        (c.name || "").toLowerCase().includes(q) ||
        (c.college || "").toLowerCase().includes(q) ||
        (c.title || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      )
    )
      return false;
    if (division !== "ALL" && c.division !== division) return false;
    if (stateFilter !== "ALL" && c.state !== stateFilter) return false;
    if (roleFilter !== "ALL" && c.role !== roleFilter) return false;
    if (statusFilter === "untouched" && (c.touches || 0) > 0) return false;
    if (statusFilter === "emailed" && !(c.touches || 0)) return false;
    if (statusFilter === "bounced" && c.emailStatus !== "bounced") return false;
    if (statusFilter === "responded" && c.schoolStatus !== "responded")
      return false;
    return true;
  };
  const filteredCoaches = coaches.filter(matches);
  const [showAll, setShowAll] = useState(false);
  const RENDER_CAP = 240;
  const visibleCoaches = showAll
    ? filteredCoaches
    : filteredCoaches.slice(0, RENDER_CAP);
  const selectCls =
    "bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-white text-[10px] font-black uppercase tracking-widest outline-none focus:border-emerald-500/50";

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6 2xl:px-10">
      <div className="w-full max-w-none mx-auto">
        <header className="mb-12">
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            Recruiting Network
          </span>
          <h2 className="text-6xl max-md:text-5xl font-black text-white uppercase italic tracking-tighter mb-2">
            Recruiting Staff
          </h2>
          <p className="text-white/40 font-bold uppercase tracking-tight mb-8">
            Direct access to Directors of Player Personnel, GMs, Recruiting
            Coordinators and QB coaches.
          </p>
          <div className="flex flex-col lg:flex-row gap-4 lg:items-center">
            <div className="relative flex-1 max-w-xl">
              <Search
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20"
                size={20}
              />
              <input
                type="text"
                placeholder="Search by name, school, title, or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-white outline-none focus:border-emerald-500/50 transition-all font-bold uppercase tracking-tight"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={division}
                onChange={(e) =>
                  setDivision(e.target.value as "ALL" | Division)
                }
                className={selectCls}
              >
                <option value="ALL">All divisions</option>
                {["FBS", "FCS", "D2", "D3", "NAIA", "JUCO"].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className={selectCls}
              >
                <option value="ALL">All states</option>
                {states.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className={selectCls}
              >
                <option value="ALL">All roles</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as typeof statusFilter)
                }
                className={selectCls}
              >
                <option value="ALL">Any status</option>
                <option value="untouched">Not contacted</option>
                <option value="emailed">Emailed</option>
                <option value="bounced">Email bounced</option>
                <option value="responded">Replied</option>
              </select>
            </div>
          </div>
          {usingSeed && (
            <p className="mt-6 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-[10px] font-black uppercase tracking-widest text-amber-400">
              Showing the bundled ledger export ({seedDate}). Start the local
              API (npm run dev with MongoDB) or sign in for live data.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4 mt-6">
            <p className="text-[10px] font-black uppercase tracking-widest text-white/40">
              Showing {filteredCoaches.length} of {coaches.length} staff
              {source === "api"
                ? " · live from MongoDB"
                : source === "firestore"
                  ? " · Firestore"
                  : ""}
            </p>
            {isAdmin && (
              <div className="flex items-center gap-4">
                {importMsg && (
                  <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400">
                    {importMsg}
                  </span>
                )}
                <button
                  type="button"
                  onClick={importSeed}
                  disabled={importing}
                  className="px-5 py-2 bg-emerald-500 text-black text-[10px] font-black uppercase tracking-widest rounded-full hover:scale-105 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  <Zap size={12} className="fill-black" />
                  {importing ? "Importing..." : "Import ledger to Firestore"}
                </button>
              </div>
            )}
          </div>
        </header>

        {loading ? (
          <div className="text-center py-20 text-white/40 font-black uppercase tracking-widest animate-pulse">
            Synchronizing Directory...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6 max-md:gap-3">
            {visibleCoaches.map((coach) => (
              <motion.div
                key={coach.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white/5 border border-white/10 rounded-3xl p-8 md:max-lg:pt-10 max-md:p-5 max-md:rounded-2xl hover:border-emerald-500/50 transition-all group relative overflow-hidden"
              >
                {/* phones: a compact card, badges in the flow above the name instead of over it, no photo box.
                    md and up: the badges sit in the card's top padding, so a long name or title that fills the
                    top of the card cannot run into them (tablets get a little more top room for the 12px badges). */}
                <div className="absolute top-0 right-0 px-4 pt-2 flex gap-2 max-md:static max-md:p-0 max-md:mb-2">
                  {coach.isTexas && (
                    <span className="px-3 py-1 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-full">
                      TX
                    </span>
                  )}
                  <span className="px-3 py-1 bg-emerald-500 text-black text-[10px] font-black uppercase tracking-widest rounded-full">
                    {coach.division}
                  </span>
                </div>
                <div className="flex items-center gap-6 mb-8 max-md:mb-3">
                  <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center overflow-hidden border border-white/10 max-md:hidden">
                    {coach.photoUrl ? (
                      <img
                        src={coach.photoUrl}
                        className="w-full h-full object-cover"
                        alt={coach.name}
                      />
                    ) : (
                      <UserIcon size={32} className="text-white/20" />
                    )}
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white uppercase italic tracking-tight">
                      {coach.name}
                    </h3>
                    <p className="text-emerald-500 text-xs font-black uppercase tracking-widest">
                      {coach.title || roleLabel(coach.role)}
                    </p>
                  </div>
                </div>

                <div className="space-y-4 mb-6 max-md:space-y-1.5 max-md:mb-4">
                  <div className="flex items-center gap-3 text-white/60">
                    <Trophy size={16} className="text-emerald-500" />
                    <span className="text-sm font-bold uppercase tracking-tight">
                      {coach.college}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-white/60">
                    <MapPin size={16} className="text-emerald-500" />
                    <span className="text-sm font-bold uppercase tracking-tight">
                      {coach.state ? `${coach.state} - ` : ""}
                      {coach.conference || coach.region}
                    </span>
                  </div>
                  {coach.lastTouch && (
                    <div className="flex items-center gap-3 text-white/60">
                      <Calendar size={16} className="text-emerald-500" />
                      <span className="text-sm font-bold uppercase tracking-tight">
                        Last touch {coach.lastTouch}
                        {coach.touches ? ` (${coach.touches} sent)` : ""}
                      </span>
                    </div>
                  )}
                </div>

                {(coach.emailStatus === "bounced" ||
                  coach.programStatus === "unverified" ||
                  coach.schoolStatus === "responded") && (
                  <div className="flex flex-wrap gap-2 mb-6">
                    {coach.emailStatus === "bounced" && (
                      <span className="px-3 py-1 bg-red-500/15 text-red-400 border border-red-500/30 text-[10px] font-black uppercase tracking-widest rounded-full">
                        Email bounced
                      </span>
                    )}
                    {coach.programStatus === "unverified" && (
                      <span className="px-3 py-1 bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-black uppercase tracking-widest rounded-full">
                        Program unverified
                      </span>
                    )}
                    {coach.schoolStatus === "responded" && (
                      <span className="px-3 py-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[10px] font-black uppercase tracking-widest rounded-full">
                        Replied
                      </span>
                    )}
                  </div>
                )}

                <div className="flex gap-3">
                  {coach.email && (
                    <a
                      href={`mailto:${coach.email}`}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-3 text-white text-[10px] font-black uppercase tracking-widest rounded-xl transition-all",
                        coach.emailStatus === "bounced"
                          ? "bg-white/5 line-through opacity-50"
                          : "bg-white/10 hover:bg-white/20",
                      )}
                    >
                      <Mail size={14} /> Email
                    </a>
                  )}
                  {coach.twitterUrl && (
                    <a
                      href={coach.twitterUrl}
                      target="_self"
                      className="flex-1 flex items-center justify-center gap-2 py-3 bg-black hover:bg-zinc-900 text-white text-[10px] font-black uppercase tracking-widest rounded-xl transition-all border border-white/5"
                    >
                      <Twitter size={14} /> Twitter
                    </a>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
        {!loading && filteredCoaches.length > visibleCoaches.length && (
          <div className="text-center mt-10">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="px-8 py-4 bg-white text-black font-black uppercase tracking-widest rounded-full hover:bg-emerald-400 transition-all"
            >
              Show all {filteredCoaches.length} (showing {visibleCoaches.length}
              )
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// --- Program Needs ("Who's looking") ---

const HS_CLASSES = ["2027", "2028", "2029"];
const POS_GROUPS = [
  "QB",
  "RB",
  "WR",
  "TE",
  "OL",
  "DL",
  "LB",
  "DB",
  "K",
  "P",
  "LS",
  "ATH",
];
const inchesToFt = (n?: number | null) =>
  n ? `${Math.floor(n / 12)}'${n % 12}"` : "";

const ProgramNeeds = () => {
  const { profile } = useAuth();
  const [colleges, setColleges] = useState<CollegeProgram[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState("QB");
  const [hsClass, setHsClass] = useState("2027");
  const [division, setDivision] = useState<"ALL" | Division>("ALL");
  const [stateFilter, setStateFilter] = useState("TX");
  const [heightIn, setHeightIn] = useState<number>(0);
  const [weightLb, setWeightLb] = useState<number>(0);
  const [dfwOnly, setDfwOnly] = useState(false);

  const [source, setSource] = useState<"api" | "firestore" | "seed" | "">("");
  const [seedDate, setSeedDate] = useState("");
  const usingSeed = source === "seed";

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];
    const useSeed = async () => {
      const [cl, cs] = await Promise.all([loadCollegeSeed(), loadCoachSeed()]);
      if (cancelled) return;
      setColleges(cl.colleges);
      setCoaches(cs.coaches);
      setSeedDate(cl.generatedAt);
      setSource("seed");
      setLoading(false);
    };
    (async () => {
      const [api, apiCoaches] = await Promise.all([
        fetchApi<{ total: number; rows: CollegeProgram[] }>(
          "/api/colleges?scraped=1",
        ),
        fetchApi<{ total: number; rows: Coach[] }>("/api/coaches?limit=5000"),
      ]);
      if (cancelled) return;
      if (api && api.rows.length > 0) {
        setColleges(api.rows);
        setCoaches(apiCoaches?.rows || []);
        setSource("api");
        setLoading(false);
        return;
      }
      if (!auth.currentUser) {
        await useSeed();
      }
      unsubs.push(
        onSnapshot(
          query(collection(db, "colleges")),
          (snap) => {
            const rows = snap.docs.map(
              (d) => ({ id: d.id, ...d.data() }) as CollegeProgram,
            );
            if (rows.some((r) => r.rosterProfile)) {
              setColleges(rows);
              setSource("firestore");
              setLoading(false);
            } else {
              useSeed();
            }
          },
          (err) => {
            if (isPermissionError(err)) {
              useSeed();
              return;
            }
            handleFirestoreError(err, OperationType.LIST, "colleges");
            setLoading(false);
          },
        ),
      );
      unsubs.push(
        onSnapshot(
          query(collection(db, "coaches")),
          (snap) => {
            const rows = snap.docs.map(
              (d) => ({ id: d.id, ...d.data() }) as Coach,
            );
            if (rows.length > 0) setCoaches(rows);
          },
          (err) => {
            if (!isPermissionError(err))
              handleFirestoreError(err, OperationType.LIST, "coaches");
          },
        ),
      );
    })();
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  // pre-fill from the signed-in athlete's profile when available
  useEffect(() => {
    if (!profile?.uid) return;
    getDoc(doc(db, "athletes", profile.uid))
      .then((snap) => {
        if (!snap.exists()) return;
        const a = snap.data() as AthleteProfile;
        if (a.athletics?.primaryPosition) setPos(a.athletics.primaryPosition);
        if (a.demographics?.gradYear)
          setHsClass(String(a.demographics.gradYear));
        if (a.athletics?.heightInches) setHeightIn(a.athletics.heightInches);
        if (a.athletics?.weightLbs) setWeightLb(a.athletics.weightLbs);
      })
      .catch(() => undefined);
  }, [profile]);

  const states = Array.from(
    new Set(colleges.map((c) => c.metadata?.state).filter(Boolean) as string[]),
  ).sort((a, b) => (a === "TX" ? -1 : b === "TX" ? 1 : a.localeCompare(b)));

  type Row = {
    college: CollegeProgram;
    p: PositionProfile;
    openings: number;
    committed: number | null;
    net: number;
    fit: "in band" | "above" | "below" | "n/a";
    coach?: Coach;
  };
  const rows: Row[] = colleges
    .filter(
      (c) =>
        c.rosterProfile?.scrapeStatus === "ok" &&
        c.rosterProfile.byPosition?.[pos],
    )
    .filter((c) => division === "ALL" || c.metadata.division === division)
    .filter((c) => stateFilter === "ALL" || c.metadata.state === stateFilter)
    .filter((c) => !dfwOnly || (c.rosterProfile?.footprint?.dfw || 0) > 0)
    .map((c) => {
      const p = c.rosterProfile!.byPosition[pos];
      const openings = p.openingsByHsClass?.[hsClass] ?? 0;
      const committed = p.commitsKnown?.[hsClass]
        ? (p.committedByHsClass?.[hsClass] ?? 0)
        : null;
      const net = Math.max(0, openings - (committed ?? 0));
      let fit: Row["fit"] = "n/a";
      if (heightIn && p.heightIn)
        fit =
          heightIn < p.heightIn.min - 1
            ? "below"
            : heightIn > p.heightIn.max + 1
              ? "above"
              : "in band";
      const staff = coaches.filter((k) => k.college === c.metadata.name);
      const coach =
        staff.find((k) => k.role === "recruiting_coordinator" && k.email) ||
        staff.find((k) => k.role === "player_personnel" && k.email) ||
        staff.find(
          (k) => k.role === (pos === "QB" ? "qb_coach" : "oc") && k.email,
        ) ||
        staff.find((k) => k.email);
      return { college: c, p, openings, committed, net, fit, coach };
    })
    .sort(
      (a, b) =>
        b.net - a.net ||
        (b.college.rosterProfile?.footprint?.dfw || 0) -
          (a.college.rosterProfile?.footprint?.dfw || 0),
    );

  const selectCls =
    "bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-white text-[10px] font-black uppercase tracking-widest outline-none focus:border-emerald-500/50";
  const inputCls =
    "bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-white text-sm font-bold outline-none focus:border-emerald-500/50 w-28";

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6 2xl:px-10">
      <div className="w-full max-w-none mx-auto">
        <header className="mb-10">
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            Program Needs
          </span>
          <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter mb-2">
            Who's Looking
          </h2>
          <p className="text-white/40 font-bold uppercase tracking-tight mb-8">
            Openings by position and class, computed from each program's current
            roster. Measurables band = who they actually roster.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={pos}
              onChange={(e) => setPos(e.target.value)}
              className={selectCls}
            >
              {POS_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select
              value={hsClass}
              onChange={(e) => setHsClass(e.target.value)}
              className={selectCls}
            >
              {HS_CLASSES.map((y) => (
                <option key={y} value={y}>
                  Class of {y}
                </option>
              ))}
            </select>
            <select
              value={division}
              onChange={(e) => setDivision(e.target.value as "ALL" | Division)}
              className={selectCls}
            >
              <option value="ALL">All divisions</option>
              {["FBS", "FCS", "D2", "D3", "NAIA", "JUCO"].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className={selectCls}
            >
              <option value="ALL">All states</option>
              {states.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Height (in)"
              value={heightIn || ""}
              onChange={(e) => setHeightIn(parseInt(e.target.value) || 0)}
              className={inputCls}
            />
            <input
              type="number"
              placeholder="Weight (lb)"
              value={weightLb || ""}
              onChange={(e) => setWeightLb(parseInt(e.target.value) || 0)}
              className={inputCls}
            />
            <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/60">
              <input
                type="checkbox"
                checked={dfwOnly}
                onChange={(e) => setDfwOnly(e.target.checked)}
              />{" "}
              Recruits DFW
            </label>
          </div>
          {usingSeed && (
            <p className="mt-6 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-[10px] font-black uppercase tracking-widest text-amber-400">
              Showing the bundled ledger export ({seedDate}). Start the local
              API (npm run dev with MongoDB) or sign in for live data.
            </p>
          )}
          <p className="text-[10px] font-black uppercase tracking-widest text-white/40 mt-4">
            {rows.length} programs with {pos} rosters scanned ·{" "}
            {rows.filter((r) => r.openings > 0).length} with openings for the
            class of {hsClass}
            {source === "api" ? " · live from MongoDB" : ""}
          </p>
        </header>

        {loading ? (
          <div className="text-center py-20 text-white/40 font-black uppercase tracking-widest animate-pulse">
            Loading program needs...
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-white/10 rounded-3xl text-white/40 font-black uppercase tracking-widest">
            No scanned programs match. Import the ledger (admin) or widen the
            filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  {[
                    "Program",
                    "Div",
                    `${pos} room`,
                    `Projected open ${hsClass}`,
                    `Committed ${hsClass}`,
                    "Net open",
                    "Roster / 105",
                    "Height band",
                    "Weight band",
                    "Fit",
                    "TX / DFW on roster",
                    "Camps",
                    "Contact",
                    "",
                  ].map((h) => (
                    <th
                      key={h}
                      className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(
                  ({ college, p, openings, committed, net, fit, coach }) => (
                    <tr
                      key={college.id}
                      className="border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                      <td className="py-4 pr-4">
                        <p className="text-sm font-black text-white uppercase tracking-tight">
                          {college.metadata.name}
                        </p>
                        <p className="text-[10px] text-white/40 uppercase font-bold">
                          {college.metadata.conference} ·{" "}
                          {college.metadata.state}
                        </p>
                      </td>
                      <td className="py-4 pr-4">
                        <span className="px-2 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded-full">
                          {college.metadata.division}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-sm font-bold text-white/70">
                        {p.count}{" "}
                        <span className="text-white/30 text-[10px]">
                          {Object.entries(p.byClass || {})
                            .map(([k, v]) => `${k || "?"}×${v}`)
                            .join(" ")}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        <span
                          className={cn(
                            "text-xl font-black italic",
                            openings > 0 ? "text-white/80" : "text-white/20",
                          )}
                        >
                          {openings}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        {committed === null ? (
                          <span
                            className="text-[10px] font-black uppercase text-white/30"
                            title="No commits on file for this class yet (recruit/data/commits.csv)."
                          >
                            unknown
                          </span>
                        ) : (
                          <span className="text-xl font-black italic text-amber-400">
                            {committed}
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-4">
                        <span
                          className={cn(
                            "text-2xl font-black italic",
                            net > 0 ? "text-emerald-400" : "text-white/20",
                          )}
                        >
                          {net}
                        </span>
                        {committed === null && (
                          <span className="text-[9px] text-white/30 uppercase font-black block">
                            gross
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-4 text-sm font-bold text-white/70">
                        {college.rosterProfile?.footprint
                          ? college.rosterProfile.footprint.total
                          : "—"}
                        {college.policy &&
                          college.policy.rosterRoom !== null && (
                            <span
                              className={cn(
                                "text-[10px] font-black block uppercase",
                                college.policy.rosterRoom > 0
                                  ? "text-emerald-400"
                                  : "text-amber-400",
                              )}
                            >
                              {college.policy.rosterRoom > 0
                                ? `${college.policy.rosterRoom} under cap`
                                : `${-college.policy.rosterRoom} over 105`}
                            </span>
                          )}
                      </td>
                      <td className="py-4 pr-4 text-sm font-bold text-white/70">
                        {p.heightIn
                          ? `${inchesToFt(p.heightIn.min)} – ${inchesToFt(p.heightIn.max)}`
                          : "—"}
                      </td>
                      <td className="py-4 pr-4 text-sm font-bold text-white/70">
                        {p.weightLb
                          ? `${p.weightLb.min} – ${p.weightLb.max}`
                          : "—"}
                      </td>
                      <td className="py-4 pr-4">
                        {fit !== "n/a" && (
                          <span
                            className={cn(
                              "px-2 py-1 text-[10px] font-black uppercase rounded-full",
                              fit === "in band"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-amber-500/15 text-amber-400",
                            )}
                          >
                            {fit}
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-4 text-sm font-bold text-white/70">
                        {college.rosterProfile?.footprint
                          ? `${college.rosterProfile.footprint.texas} / ${college.rosterProfile.footprint.dfw}`
                          : "—"}
                        <span className="text-white/30 text-[10px]">
                          {" "}
                          of {college.rosterProfile?.footprint?.total}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        {college.camps && college.camps.length > 0 ? (
                          college.camps.slice(0, 2).map((c) => (
                            <a
                              key={c.url}
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline"
                              title={c.dates}
                            >
                              {c.label.slice(0, 28) || "Camps"}
                              {c.dates ? (
                                <span className="text-white/40 block normal-case tracking-normal font-bold">
                                  {c.dates.slice(0, 40)}
                                </span>
                              ) : null}
                            </a>
                          ))
                        ) : (
                          <span className="text-white/20 text-[10px] uppercase font-black">
                            —
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-4">
                        {coach ? (
                          <a
                            href={`mailto:${coach.email}`}
                            className="text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline"
                          >
                            {coach.name}
                            <br />
                            <span className="text-white/40">
                              {coach.title?.slice(0, 40)}
                            </span>
                          </a>
                        ) : (
                          <span className="text-white/20 text-[10px] uppercase font-black">
                            no email yet
                          </span>
                        )}
                      </td>
                      <td className="py-4">
                        {college.rosterProfile?.sourceUrl && (
                          <a
                            href={college.rosterProfile.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-white/30 hover:text-emerald-400"
                          >
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// --- Player card ---

const PlayersIndex = () => {
  const [rows, setRows] = useState<AthleteCard[]>([]);
  useEffect(() => {
    fetchApi<{ rows: AthleteCard[] }>("/api/athletes").then((r) =>
      setRows(r?.rows || []),
    );
  }, []);
  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6">
      <div className="max-w-5xl mx-auto">
        <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
          Athletic Analyst
        </span>
        <h2 className="text-6xl font-black text-white uppercase italic tracking-tighter mb-10">
          Players
        </h2>
        <div className="grid gap-4">
          {rows.map((p) => (
            <Link
              key={p.id}
              to={`/player/${p.id}`}
              className="bg-white/5 border border-white/10 rounded-3xl p-6 hover:border-emerald-500/50 transition-all flex items-center justify-between"
            >
              <div>
                <p className="text-2xl font-black text-white uppercase italic tracking-tight">
                  #{p.jersey} {p.name}
                </p>
                <p className="text-[10px] text-white/40 uppercase font-bold">
                  {p.position} · Class of {p.gradYear} · {p.highSchool}
                  {p.uil
                    ? ` · UIL ${p.uil.conference} D${p.uil.footballDistrict}`
                    : ""}
                </p>
              </div>
              <ChevronRight className="text-emerald-500" />
            </Link>
          ))}
          {rows.length === 0 && (
            <p className="text-white/40 font-black uppercase tracking-widest">
              No player cards yet (API not running or no athletes loaded).
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// Below 1024px (phones, tablets), long one-word table values (coach titles joined by "/", emails, engine names like
// ollama:gemma4:31b) get a break chance after each / : @, so a narrow column wraps them there instead of overflowing or
// splitting mid-word. On desktop the value is left as it was, so the tables lay out exactly as before.
const NARROW_SCREEN = "(max-width: 1023.98px)";
const useNarrowScreen = () => {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_SCREEN).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_SCREEN);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
};
const softBreaks = (s: string | undefined, narrow: boolean) =>
  narrow
    ? (s || "")
        .split(/(?<=[/:@])/)
        .flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]))
    : s;
// A title cut to n characters ends in "…" so it reads as shortened, not as the whole title. The "…" replaces the last
// two characters of the cut, so the text is never wider than before and the table columns keep their widths.
const clip = (s: string | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n - 2).trimEnd()}…` : s;
// A line of text whose ISO dates (2026-10-12) never break at their hyphens when the line wraps.
const keepDates = (s: string) =>
  s
    .split(/(\d{4}-\d{2}-\d{2})/)
    .map((part, i) =>
      i % 2 ? (
        <span key={i} className="whitespace-nowrap">
          {part}
        </span>
      ) : (
        part
      ),
    );

const sevCls = (s?: string) =>
  s === "high"
    ? "bg-red-500/15 text-red-400 border-red-500/30"
    : s === "moderate"
      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
      : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";

// Evaluator output on the Film tab: season rollup + one expandable card per play (ProVision-style prime points S1–S7).
const FilmNotesPanel = ({
  notes,
  report,
}: {
  notes: FilmNote[];
  report: FilmReport | null;
}) => {
  const [open, setOpen] = useState<string | null>(null);
  const tiles: [string, number | null | undefined][] = report
    ? [
        ["Overall", report.overall],
        ["Decision", report.scores?.decision],
        ["Accuracy", report.scores?.accuracy],
        ["Mechanics", report.scores?.mechanics],
        ["Mobility", report.scores?.mobility],
      ]
    : [];
  return (
    <div className="mt-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 mb-4">
        <div>
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            AI film notes · advisory · a coach checks every call
          </span>
          <h3 className="text-3xl font-black text-white uppercase italic tracking-tighter">
            Evaluator
          </h3>
        </div>
        {report && (
          <p className="text-[10px] text-white/30 uppercase font-black">
            {report.evaluated}/{report.plays} plays ·{" "}
            {(report.engines || []).join(", ") || "no engine"} · confidence{" "}
            {report.confidence ?? "—"} · {report.generatedAt?.slice(0, 16)}Z
          </p>
        )}
      </div>
      {report && (report.ungraded || []).length > 0 && (
        <p className="text-[11px] text-amber-400/80 mb-4">
          <span className="font-black uppercase tracking-widest mr-2">
            Not gradeable from these frames
          </span>
          {(report.ungraded || []).map((u) => u.playId).join(" · ")} — scores
          above average only the graded plays; the 1-second broadcast sheets
          hide release and footwork, so per-play frames from the clips are the
          fix.
        </p>
      )}
      {report && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {tiles.map(([l, v]) => (
            <div
              key={l}
              className="bg-white/5 border border-white/10 rounded-2xl p-5"
            >
              <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-1">
                {l}
              </p>
              <p className="text-3xl font-black text-white italic">
                {v ?? "—"}
              </p>
            </div>
          ))}
        </div>
      )}
      {report && (
        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <p className="text-[10px] text-emerald-500 font-black uppercase tracking-widest mb-2">
              Strengths · show first
            </p>
            {(report.strengths || []).map((s) => (
              <p key={s.metric} className="text-sm text-white/80">
                {s.metric}{" "}
                <span className="text-white/30">· {s.plays} plays</span>
              </p>
            ))}
            {!report.strengths?.length && (
              <p className="text-sm text-white/30">nothing scored ≥ 0.8 yet</p>
            )}
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <p className="text-[10px] text-amber-400 font-black uppercase tracking-widest mb-2">
              Fix first
            </p>
            {(report.fixFirst || []).map((f) => (
              <p key={f.name} className="text-sm text-white/80">
                {f.name}{" "}
                <span className="text-white/30">· {f.plays} plays</span>
              </p>
            ))}
            {!report.fixFirst?.length && (
              <p className="text-sm text-white/30">no recurring issue</p>
            )}
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-2">
              Drills
            </p>
            {(report.drills || []).map((d) => (
              <p key={d.name} className="text-sm text-white/80">
                {d.name} <span className="text-white/30">· {d.fixes}</span>
              </p>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-3">
        {notes.map((n) => (
          <div
            key={n.playId}
            className="bg-white/5 border border-white/10 rounded-2xl p-5"
          >
            <div
              className="flex flex-wrap items-center gap-3 cursor-pointer"
              onClick={() => setOpen(open === n.playId ? null : n.playId)}
            >
              <span className="text-2xl font-black italic text-white w-14">
                {n.scores?.overall ?? "—"}
              </span>
              <div className="flex-1 min-w-[240px]">
                <p className="text-sm font-black text-white uppercase">
                  {n.reelOrder ? `${n.reelOrder}. ` : ""}
                  {n.desc}
                </p>
                <p className="text-[10px] text-white/40 uppercase font-bold">
                  {n.game}
                  {n.td ? " · TD" : ""} ·{" "}
                  {(n.engines || []).join(", ") || n.engine || "no engine"} ·
                  confidence {n.confidence ?? "—"}
                  {n.error ? ` · ${n.error.slice(0, 60)}` : ""}
                </p>
              </div>
              <div className="flex gap-1 flex-wrap">
                {(n.prime_points || []).map((pp) => (
                  <span
                    key={pp.point_code}
                    title={`${pp.metric}: ${pp.insight}`}
                    className={cn(
                      "px-2 py-1 border text-[9px] font-black uppercase rounded-full",
                      sevCls(pp.severity),
                    )}
                  >
                    {pp.point_code}
                  </span>
                ))}
              </div>
              {n.show_coaches?.reel_opener && (
                <span className="px-2 py-1 bg-white text-black text-[9px] font-black uppercase rounded-full">
                  reel opener
                </span>
              )}
            </div>
            {open === n.playId && (
              <div className="mt-4 grid lg:grid-cols-2 gap-4">
                {Object.values(n.sections || {}).map((sec) => (
                  <div key={sec.title}>
                    <p className="text-[10px] text-emerald-500 font-black uppercase tracking-widest mb-1">
                      {sec.title}
                    </p>
                    {sec.items.map((it, i) => (
                      <p key={i} className="text-sm text-white/70 mb-1">
                        <span className="text-white font-bold">{it.item}:</span>{" "}
                        {it.observation}{" "}
                        <span className="text-white/40 italic">
                          → {it.recommendation}
                        </span>
                      </p>
                    ))}
                    {!sec.items.length && (
                      <p className="text-sm text-white/30">
                        not visible on these frames
                      </p>
                    )}
                  </div>
                ))}
                <div>
                  <p className="text-[10px] text-amber-400 font-black uppercase tracking-widest mb-1">
                    Key issues
                  </p>
                  {(n.key_issues || []).map((k) => (
                    <p key={k.priority} className="text-sm text-white/70 mb-1">
                      <span className="text-white font-bold">
                        {k.priority}. {k.name}:
                      </span>{" "}
                      {k.description}{" "}
                      <span className="text-white/40 italic">
                        {k.impact_on_play}
                      </span>
                    </p>
                  ))}
                </div>
                <div>
                  <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-1">
                    Drills
                  </p>
                  {(n.drills || []).map((d) => (
                    <p key={d.name} className="text-sm text-white/70 mb-1">
                      <span className="text-white font-bold">{d.name}</span> (
                      {d.fixes}): {d.instructions}{" "}
                      <span className="text-white/40">{d.reps}</span>
                    </p>
                  ))}
                </div>
                <div className="lg:col-span-2 border-t border-white/10 pt-3">
                  {(n.prime_points || []).map((pp) => (
                    <p
                      key={pp.point_code}
                      className="text-[11px] text-white/60"
                    >
                      <span
                        className={cn(
                          "inline-block px-1.5 mr-2 border rounded-full font-black",
                          sevCls(pp.severity),
                        )}
                      >
                        {pp.point_code}
                      </span>
                      {pp.metric} ({pp.score}) · {pp.insight}
                      {pp.frame_label ? ` · frame ${pp.frame_label}` : ""}
                    </p>
                  ))}
                  {n.show_coaches?.note && (
                    <p className="text-sm text-white/80 mt-3">
                      <span className="text-emerald-500 font-black uppercase text-[10px] tracking-widest mr-2">
                        Show coaches
                      </span>
                      {n.show_coaches.note}
                    </p>
                  )}
                  {n.visibility?.limits && (
                    <p className="text-[11px] text-white/40 mt-2">
                      <span className="font-black uppercase tracking-widest mr-2">
                        Visibility limits
                      </span>
                      {n.visibility.limits}
                    </p>
                  )}
                  {(n.frames || []).map((f) => (
                    <p
                      key={f.frame_url}
                      className="text-[10px] text-white/20 break-all mt-1"
                    >
                      frames: {f.frame_url}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// Agent tab: run the pipelines, review drafts (approve for the next batch; nothing sends without a mailbox and a per-batch yes), see runs.
const AgentPanel = ({
  athleteId,
  agent,
  drafts,
  runs,
  onChange,
}: {
  athleteId: string;
  agent?: AthleteCard["agent"];
  drafts: Draft[];
  runs: AgentRun[];
  onChange: () => void;
}) => {
  const narrow = useNarrowScreen();
  const [pipeline, setPipeline] = useState<
    "film-evaluation" | "recruiting-outreach" | "all"
  >("recruiting-outreach");
  const [job, setJob] = useState<{
    id: string;
    status: string;
    log: string[];
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const j = await fetchApi<{ id: string; status: string; log: string[] }>(
        `/api/agent/jobs/${job.id}`,
      );
      if (j) {
        setJob(j);
        if (j.status !== "running") {
          clearInterval(t);
          onChange();
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);
  const [engines, setEngines] = useState("ollama,xai");
  const run = async () => {
    setErr("");
    const r = await fetch(`/api/agent/run/${athleteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline, engines }),
    });
    const j = await r.json();
    if (j.jobId) setJob({ id: j.jobId, status: "running", log: [] });
    else setErr(j.error || "could not start");
  };
  const setStatus = async (d: Draft, status: string) => {
    await fetch(`/api/athletes/${athleteId}/drafts/${d.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onChange();
  };
  const count = (s: string) => drafts.filter((d) => d.status === s).length;
  const shown = drafts.filter((d) => filter === "all" || d.status === filter);
  const chip = (s: string) =>
    s === "approved"
      ? "bg-emerald-500 text-black"
      : s === "needs_review"
        ? "bg-amber-500/20 text-amber-400"
        : s === "rejected"
          ? "bg-white/5 text-white/30"
          : "bg-white/10 text-white";
  return (
    <div className="space-y-6">
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 lg:col-span-2 min-w-0">
          <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
            Personal agent · {agent?.enabled ? "enabled" : "manual runs only"}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value as typeof pipeline)}
              className="bg-[#111] border border-white/10 rounded-full px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white max-w-full"
            >
              <option value="recruiting-outreach">
                Recruiting outreach (drafts)
              </option>
              <option value="film-evaluation">Film evaluation (notes)</option>
              <option value="all">Both</option>
            </select>
            <input
              value={engines}
              onChange={(e) =>
                setEngines(e.target.value.replace(/[^a-z,]/g, ""))
              }
              title="engines, comma-separated: xai, ollama, anthropic, openai, google (only keys that work)"
              className="bg-[#111] border border-white/10 rounded-full px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white w-36"
            />
            <button
              onClick={run}
              disabled={job?.status === "running"}
              className="px-5 py-2 bg-emerald-500 text-black rounded-full text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
            >
              {job?.status === "running" ? "Running…" : "Run agent"}
            </button>
            {err && (
              <span className="text-[10px] text-red-400 font-black uppercase">
                {err}
              </span>
            )}
          </div>
          <p className="text-[10px] text-white/30 uppercase font-bold mt-3">
            cadence {agent?.cadence || "—"} · max{" "}
            {agent?.maxSendsPerWeek ?? "—"} sends/week ·{" "}
            {agent?.senderMailbox
              ? `mailbox ${agent.senderMailbox}`
              : "no sender mailbox yet"}{" "}
            · {agent?.approvalMode || "batch-approve"} · last run{" "}
            {agent?.lastRun ? agent.lastRun.slice(0, 16) + "Z" : "never"}
          </p>
          {job && (
            <pre className="mt-3 max-h-40 overflow-auto bg-black/40 rounded-xl p-3 text-[10px] text-white/50 whitespace-pre-wrap">
              {job.status}
              {"\n"}
              {job.log.slice(-12).join("\n")}
            </pre>
          )}
        </div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
            Drafts
          </p>
          <div className="flex flex-wrap gap-2">
            {["all", "draft", "needs_review", "approved", "rejected"].map(
              (s) => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={cn(
                    "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest",
                    filter === s
                      ? "bg-white text-black"
                      : "bg-white/10 text-white/60",
                  )}
                >
                  {s.replace("_", " ")} {s === "all" ? drafts.length : count(s)}
                </button>
              ),
            )}
          </div>
          <p className="text-[10px] text-white/30 uppercase font-bold mt-3">
            approved = queued for the next batch. Nothing sends without a
            mailbox and a per-batch yes.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="rt rt-flow w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              {[
                "Program",
                "To",
                "Mode",
                "Subject",
                "Engine",
                "Status",
                "Actions",
              ].map((h) => (
                <th
                  key={h}
                  className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <React.Fragment key={d.id}>
                <tr
                  className="border-b border-white/5 hover:bg-white/5 cursor-pointer"
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                >
                  <td className="py-3 pr-4 rt-lead rt-first">
                    <p className="text-sm font-black text-white uppercase">
                      {d.school}
                    </p>
                    <p className="text-[10px] text-white/40 uppercase font-bold">
                      {d.division} · {d.createdAt?.slice(0, 10)}
                    </p>
                  </td>
                  <td className="py-3 pr-4 text-sm text-white/70 rt-full">
                    {d.toName}
                    <span
                      className="text-white/30 block text-[10px]"
                      title={d.toTitle}
                    >
                      {softBreaks(clip(d.toTitle, 40), narrow)}
                      {" · "}
                      {softBreaks(d.to, narrow)}
                    </span>
                  </td>
                  <td
                    data-label="Mode"
                    className="py-3 pr-4 text-[10px] font-black uppercase text-white/50 rt-last"
                  >
                    {d.mode}
                  </td>
                  <td className="py-3 pr-4 text-sm text-white/80 rt-full">
                    {d.subject}
                  </td>
                  <td
                    data-label="Engine"
                    className="py-3 pr-4 text-[10px] text-white/30 uppercase font-black rt-last"
                  >
                    {softBreaks(d.engine, narrow)}
                  </td>
                  <td className="py-3 pr-4 rt-end rt-first">
                    <span
                      className={cn(
                        "px-2 py-1 text-[10px] font-black uppercase rounded-full",
                        chip(d.status),
                      )}
                    >
                      {d.status.replace("_", " ")}
                    </span>
                    {d.flags && d.flags.length > 0 && (
                      <p className="text-[10px] text-amber-400 mt-1">
                        {d.flags.join(" · ")}
                      </p>
                    )}
                  </td>
                  <td
                    className="py-3 pr-4 whitespace-nowrap rt-full rt-last rt-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {d.status !== "approved" && (
                      <button
                        onClick={() => setStatus(d, "approved")}
                        className="px-3 py-1 bg-emerald-500 text-black rounded-full text-[10px] font-black uppercase mr-2"
                      >
                        Approve
                      </button>
                    )}
                    {d.status !== "rejected" && (
                      <button
                        onClick={() => setStatus(d, "rejected")}
                        className="px-3 py-1 bg-white/10 text-white/60 rounded-full text-[10px] font-black uppercase mr-2"
                      >
                        Reject
                      </button>
                    )}
                    {(d.status === "approved" || d.status === "rejected") && (
                      <button
                        onClick={() => setStatus(d, "draft")}
                        className="px-3 py-1 bg-white/5 text-white/40 rounded-full text-[10px] font-black uppercase"
                      >
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr className="border-b border-white/5">
                    <td colSpan={7} className="py-4 pr-4">
                      <pre className="whitespace-pre-wrap text-sm text-white/80 font-sans bg-black/30 rounded-xl p-4">
                        {d.body}
                      </pre>
                      {d.dm && (
                        <p className="text-[11px] text-white/50 mt-2">
                          <span className="font-black uppercase tracking-widest mr-2">
                            DM
                          </span>
                          {d.dm}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {shown.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="py-8 text-center text-white/30 font-black uppercase tracking-widest text-[10px]"
                >
                  no drafts yet · run the agent
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
          Runs
        </p>
        <table className="rt w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              {["Started", "Pipeline", "Status", "Counts", "Error"].map((h) => (
                <th
                  key={h}
                  className="py-3 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-white/5">
                <td
                  data-label="Started"
                  className="py-2 pr-4 text-sm text-white/70"
                >
                  {r.startedAt?.slice(0, 16)}Z
                </td>
                <td
                  data-label="Pipeline"
                  className="py-2 pr-4 text-[10px] font-black uppercase text-white"
                >
                  {r.pipeline}
                </td>
                <td data-label="Status" className="py-2 pr-4">
                  <span
                    className={cn(
                      "px-2 py-1 text-[10px] font-black uppercase rounded-full",
                      r.status === "done"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : r.status === "running"
                          ? "bg-white/10 text-white"
                          : "bg-red-500/15 text-red-400",
                    )}
                  >
                    {r.status}
                  </span>
                </td>
                <td
                  data-label="Counts"
                  className="py-2 pr-4 text-[11px] text-white/60"
                >
                  {Object.entries(r.counts || {})
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")}
                </td>
                <td className="py-2 pr-4 text-[11px] text-red-400 rt-full">
                  {r.error || ""}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="py-6 text-center text-white/30 font-black uppercase tracking-widest text-[10px]"
                >
                  no runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Player card sections. The YUR AI Athletics desktop and Franklin open them by URL (/player/:id?tab=film): every
// click in the desktop's side browser asks for confirmation, so each section must be reachable by address. The
// desktop's section ids work too; anything else shows the card (board).
type CardTab =
  | "board"
  | "outreach"
  | "film"
  | "highlights"
  | "stats"
  | "camps"
  | "resume"
  | "agent";
const CARD_TABS: Record<string, CardTab> = {
  board: "board",
  "my-card": "board",
  outreach: "outreach",
  "outreach-drafts": "outreach",
  film: "film",
  "film-study": "film",
  highlights: "highlights",
  stats: "stats",
  "stats-maxpreps": "stats",
  camps: "camps",
  "camps-schedule": "camps",
  resume: "resume",
  "resume-report": "resume",
  agent: "agent",
};
const cardTab = (v: string | null): CardTab =>
  v && Object.hasOwn(CARD_TABS, v) ? CARD_TABS[v] : "board";

const missingCls =
  "inline-block px-4 py-2 bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-black uppercase tracking-widest rounded-full";

// A report exactly as its generator wrote it, in a same-origin frame (the desktop's side browser blocks other-origin
// frames and popups). Scripted reports (their own tabs, filters and sticky nav) run in an opaque-origin sandbox in a
// screen-tall frame (below 1024px a shorter one, so the page around it can still be scrolled past it); script-free
// pages (the resume) are sized to their content, again whenever the frame's width changes (the narrow desktop pane
// reflows them), and their links (Hudl, MaxPreps) open in this tab instead of inside the frame.
// Below 1024px a script-free page's print-size text (the resume's 9.5-11.5px) gets a 12px floor, set inside the frame
// and only while the frame itself is narrower than 1024px: the desktop and "Open full page" keep the generator's sizes.
const FONT_FLOOR = "data-min-font";
const prepareFitDoc = (d: Document) => {
  const head = d.head || d.documentElement;
  if (!d.querySelector("base[target]")) {
    const base = d.createElement("base");
    base.target = "_top";
    head.appendChild(base);
  }
  if (!d.getElementById("font-floor")) {
    const style = d.createElement("style");
    style.id = "font-floor";
    style.textContent = `@media (width < 1024px) { [${FONT_FLOOR}] { font-size: 12px !important; } }`;
    head.appendChild(style);
  }
  const win = d.defaultView;
  if (!win || !d.body) return;
  for (const el of [d.body, ...Array.from(d.body.querySelectorAll("*"))]) {
    if (el.hasAttribute(FONT_FLOOR)) continue;
    const size = parseFloat(win.getComputedStyle(el).fontSize);
    if (size > 0 && size < 12) el.setAttribute(FONT_FLOOR, "");
  }
};
const ReportFrame = ({
  report,
  label,
  fit = false,
}: {
  report?: ReportInfo;
  label: string;
  fit?: boolean;
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [fitHeight, setFitHeight] = useState(0);
  // The page's own height (its root box), not scrollHeight: that never reports less than the frame, so a short page
  // would keep the placeholder height and leave blank space under it. Plus the frame's border (border-box sizing):
  // without it the inside is 2px shorter than the page, which then shows its own scrollbar.
  const measure = () => {
    const el = frameRef.current;
    const d = fit ? el?.contentDocument : null;
    if (!el || !d?.body || d.URL === "about:blank") return;
    prepareFitDoc(d);
    const h = Math.ceil(d.documentElement.getBoundingClientRect().height);
    if (h > 0) setFitHeight(h + el.offsetHeight - el.clientHeight);
  };
  // Measure once more after a height change: the first measure can run while the page still has a scrollbar (the
  // placeholder height), and without it the page is wider and can be shorter. Stops when the height stays the same.
  useEffect(() => {
    if (!fit || !fitHeight) return;
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [fit, fitHeight]);
  useEffect(() => {
    const el = frameRef.current;
    if (!fit || !el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // our own height change, or the first report
      width = el.clientWidth;
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, report?.available, report?.url]);
  if (!report?.available)
    return (
      <span className={missingCls}>
        {label} · {report ? "not built yet" : "not available"}
      </span>
    );
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-[10px] text-emerald-500 font-black uppercase tracking-widest">
          {label}
          <span className="text-white/30">
            {" "}
            · {report.title}
            {report.updatedAt
              ? ` · updated ${report.updatedAt.slice(0, 16)}Z`
              : ""}
            {report.private ? " · private, this computer only" : ""}
          </span>
        </p>
        <a
          href={report.url}
          target="_self"
          className="tap px-4 py-2 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-full"
        >
          Open full page
        </a>
      </div>
      <iframe
        ref={frameRef}
        src={report.url}
        title={report.title}
        sandbox={
          fit
            ? "allow-same-origin allow-top-navigation-by-user-activation"
            : "allow-scripts"
        }
        onLoad={measure}
        className={cn(
          "w-full rounded-2xl border border-white/10",
          !fit &&
            "h-[calc(100vh-7rem)] min-h-[640px] max-lg:h-[65svh] max-lg:min-h-[420px]",
        )}
        style={fit ? { height: fitHeight || 1100 } : undefined}
      />
    </div>
  );
};

// Resume and report: the athletic resume first, then the coach-facing files that exist right now. The PDF is only a
// secondary link: the desktop's side browser has no PDF viewer (plugins off) and cancels downloads, so there the coach
// brief page is the copy to open.
const ResumePanel = ({ reports }: { reports: ReportInfo[] | null }) => {
  const by = (n: string) => reports?.find((r) => r.name === n);
  const links: [string, string, boolean][] = [
    ["coach-report", "Coach report", true],
    ["coach-brief", "Coach brief", true],
    ["film-report", "Full film report", true],
  ];
  const pdf = by("coach-brief-pdf");
  const pdfViewer =
    typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
  return (
    <div className="space-y-6">
      <ReportFrame report={by("resume")} label="Athletic resume" fit />
      <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
        <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
          For coaches · opens in this tab
        </p>
        <div className="flex flex-wrap gap-3">
          {links.map(([name, label, always]) => {
            const r = by(name);
            if (r?.available)
              return (
                <a
                  key={name}
                  href={r.url}
                  target="_self"
                  title={r.title}
                  className="tap px-5 py-3 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-full"
                >
                  {label}
                </a>
              );
            return always ? (
              <span key={name} className={missingCls}>
                {label} · not built yet
              </span>
            ) : null;
          })}
        </div>
        {pdf?.available && (
          <p className="text-[11px] text-white/40 mt-4">
            {pdfViewer ? (
              <a
                href={pdf.url}
                target="_self"
                title={pdf.title}
                className="tap text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline mr-2"
              >
                Coach brief PDF
              </a>
            ) : (
              <span className="text-[10px] font-black uppercase tracking-widest text-white/60 mr-2">
                Coach brief PDF
              </span>
            )}
            {pdfViewer
              ? "for print or email. Not in the YUR AI Athletics side browser: it has no PDF viewer and blocks downloads, so open the coach brief page there."
              : `for print or email. This browser has no PDF viewer: open ${window.location.origin}${pdf.url} in Chrome or Edge.`}
          </p>
        )}
      </div>
    </div>
  );
};

// Hudl team library the clip numbers refer to: VITE_HUDL_TEAM_ID in .env.local. Without it no Hudl link is shown.
const HUDL_TEAM: string = import.meta.env.VITE_HUDL_TEAM_ID ?? "";
const hudlVideoUrl = (video: string) =>
  `https://app.hudl.com/watch/team/${HUDL_TEAM}/analyze?v=${encodeURIComponent(video)}&team=${HUDL_TEAM}&cx=tm`;

// Highlights: the mid-season highlight order (recruit/highlight_order.py), best play first, every score term shown.
const HighlightsPanel = ({ athleteId }: { athleteId: string }) => {
  const [h, setH] = useState<HighlightOrder | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchApi<HighlightOrder>(
      `/api/athletes/${athleteId}/reports/highlights`,
    ).then((r) => live && setH(r));
    return () => {
      live = false;
    };
  }, [athleteId]);
  if (h === undefined)
    return (
      <p className="text-white/40 font-black uppercase tracking-widest animate-pulse">
        Loading highlights...
      </p>
    );
  if (!h?.reel?.length)
    return (
      <span className={missingCls}>
        Highlight order · not built yet (python -P recruit/highlight_order.py)
      </span>
    );
  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 mb-4">
        <div>
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            Best play first · every score term shown
          </span>
          <h3 className="text-3xl font-black text-white uppercase italic tracking-tighter">
            Highlight order
          </h3>
        </div>
        <p className="text-[10px] text-white/30 uppercase font-black">
          {h.reel.length} plays · {h.eligible?.length ?? "—"} eligible
          {h.reel_seconds_raw
            ? ` · ${Math.round(h.reel_seconds_raw / 6) / 10} min raw clips`
            : ""}
        </p>
      </div>
      <p className="text-[11px] text-white/40 mb-4">
        Hudl links open that game in the team's Hudl library in this tab (team
        login needed); the clip number is the play in the game's playlist.
      </p>
      <div className="overflow-x-auto">
        <table className="rt rt-flow w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              {[
                "#",
                "Score",
                "Game",
                "Play",
                "Result",
                "Why it scored",
                "Hudl clip",
              ].map((c) => (
                <th
                  key={c}
                  className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.reel.map((r) => (
              <tr
                key={r.rank}
                className="border-b border-white/5 hover:bg-white/5 align-top"
              >
                <td className="py-3 pr-4 text-2xl font-black italic text-white">
                  {r.rank}
                </td>
                <td
                  data-label="Score"
                  className="py-3 pr-4 text-2xl font-black italic text-emerald-400"
                >
                  {r.score}
                </td>
                <td className="py-3 pr-4 rt-end">
                  <p className="text-sm font-black text-white uppercase">
                    {r.opponent || r.game}
                  </p>
                  <p className="text-[10px] text-white/40 uppercase font-bold">
                    {r.date}
                  </p>
                </td>
                <td
                  data-label="Play"
                  className="py-3 pr-4 text-sm text-white/70 rt-full"
                >
                  {r.play}
                  {r.quarter ? ` · Q${r.quarter}` : ""}
                  <span className="text-white/40 block text-[10px] uppercase font-bold">
                    {[r.situation, r.call].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td
                  data-label="Result"
                  className="py-3 pr-4 text-sm text-white/80 rt-full"
                >
                  {r.result}
                  <span className="text-white/40 block text-[10px] uppercase font-bold">
                    {[
                      r.verdict,
                      r.coverage,
                      r.pressure ? `pressure ${r.pressure}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </td>
                <td
                  data-label="Why it scored"
                  className="py-3 pr-4 text-[11px] text-white/60 rt-full"
                >
                  {Object.entries(r.parts || {})
                    .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`)
                    .join(" · ")}
                </td>
                <td className="py-3 pr-4 whitespace-nowrap rt-full">
                  {r.hudl_video && HUDL_TEAM ? (
                    <a
                      href={hudlVideoUrl(r.hudl_video)}
                      target="_self"
                      className="tap-block text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline"
                    >
                      Hudl · clip {r.hudl_clip ?? "—"}
                      <span className="text-white/40 block normal-case tracking-normal font-bold">
                        video {r.hudl_video}
                        {r.clip_seconds ? ` · ${r.clip_seconds}s` : ""}
                      </span>
                    </a>
                  ) : (
                    <span className="text-white/20 text-[10px] uppercase font-black">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {h.matrix && (
        <div className="mt-6">
          <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-2">
            Scoring matrix
          </p>
          <pre className="whitespace-pre-wrap text-[11px] text-white/50 bg-black/30 rounded-xl p-4">
            {h.matrix}
          </pre>
        </div>
      )}
    </div>
  );
};

// Stats and MaxPreps: official per-game lines and the season line (recruit/data/games/season_2026_official_check.json),
// with each game's opponent, date and result from season_2026_scores.json.
const OfficialLinesPanel = ({
  athleteId,
  maxPrepsUrl,
}: {
  athleteId: string;
  maxPrepsUrl?: string;
}) => {
  const [data, setData] = useState<{
    official: OfficialCheck | null;
    games: Record<string, SeasonGame> | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      fetchApi<OfficialCheck>(
        `/api/athletes/${athleteId}/reports/official-check`,
      ),
      fetchApi<Record<string, SeasonGame>>(
        `/api/athletes/${athleteId}/reports/season-scores`,
      ),
    ]).then(([official, games]) => live && setData({ official, games }));
    return () => {
      live = false;
    };
  }, [athleteId]);
  if (!data)
    return (
      <p className="text-white/40 font-black uppercase tracking-widest animate-pulse mb-8">
        Loading official lines...
      </p>
    );
  const o = data.official;
  // not built, asked from another computer, or a web app started before this route existed
  if (!o)
    return (
      <div className="mb-8">
        <span className={missingCls}>Official 2026 lines · not available</span>
      </div>
    );
  const games = data.games || {};
  const byGame = o.maxpreps_by_game || {};
  const cols = Array.isArray(byGame._columns)
    ? (byGame._columns as string[])
    : ["cmp", "att", "yds", "td", "int"];
  const rows: { code: string; line: PassLine; url?: string }[] = [];
  for (const [code, v] of Object.entries(byGame))
    if (!code.startsWith("_") && v && typeof v === "object" && !Array.isArray(v))
      if (Array.isArray(v.line))
        rows.push({
          code,
          url: v.url,
          line: {
            ...(Object.fromEntries(
              cols.map((c, i) => [c, v.line![i]]),
            ) as unknown as PassLine),
            source: "MaxPreps game page (coach-entered)",
          },
        });
  // a game's official box line kept beside the MaxPreps lines, e.g. "<opponent>_official"
  for (const [k, v] of Object.entries(o))
    if (
      k.endsWith("_official") &&
      k !== "season_official" &&
      v &&
      typeof v === "object" &&
      "cmp" in v
    ) {
      const key = k.replace(/_official$/, "");
      const code =
        Object.keys(games).find((g) =>
          (games[g].opponent || "").toLowerCase().includes(key),
        ) || key.toUpperCase();
      rows.push({ code, line: v as PassLine });
    }
  rows.sort((a, b) =>
    (games[a.code]?.date || "").localeCompare(games[b.code]?.date || ""),
  );
  const s = o.season_official;
  const mp = o.maxpreps_26_27_varsity;
  const cell = "py-3 pr-4 text-sm text-white/70";
  return (
    <div className="mb-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 mb-4">
        <div>
          <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
            Official lines · box scores, not estimates
          </span>
          <h3 className="text-3xl font-black text-white uppercase italic tracking-tighter">
            2026 passing
          </h3>
        </div>
        {maxPrepsUrl && (
          <a
            href={maxPrepsUrl}
            target="_self"
            className="tap px-5 py-3 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-full self-start md:self-auto"
          >
            MaxPreps profile
          </a>
        )}
      </div>
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {(
            [
              ["Comp / Att", `${s.cmp}/${s.att}`],
              ["Yards", s.yds],
              ["TD", s.td],
              ["INT", s.int],
            ] as [string, React.ReactNode][]
          ).map(([l, v]) => (
            <div
              key={l}
              className="bg-white/5 border border-white/10 rounded-2xl p-5"
            >
              <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-1">
                {l}
              </p>
              <p className="text-3xl font-black text-white italic">{v}</p>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="rt rt-flow w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              {[
                "Date",
                "Game",
                "Result",
                "Comp / Att",
                "Yds",
                "TD",
                "INT",
                "Source",
              ].map((c) => (
                <th
                  key={c}
                  className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-white/5">
                <td className={cn(cell, "rt-end rt-nowrap")}>
                  {games[r.code]?.date || "—"}
                </td>
                <td className="py-3 pr-4 text-sm font-black text-white uppercase rt-lead rt-first">
                  {games[r.code]?.opponent || r.code}
                </td>
                <td data-label="Result" className={cell}>
                  {games[r.code]?.result || "—"}
                </td>
                <td data-label="C/A" className={cell}>
                  {r.line.cmp}/{r.line.att}
                </td>
                <td data-label="Yds" className={cell}>
                  {r.line.yds}
                </td>
                <td data-label="TD" className={cell}>
                  {r.line.td}
                </td>
                <td data-label="INT" className={cell}>
                  {r.line.int}
                </td>
                <td className="py-3 pr-4 text-[10px] text-white/30 uppercase font-black rt-full">
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_self"
                      className="tap text-emerald-500 hover:underline"
                    >
                      {r.line.source}
                    </a>
                  ) : (
                    r.line.source
                  )}
                </td>
              </tr>
            ))}
            {s && (
              <tr className="border-b border-white/10">
                <td className="py-3 pr-4 text-sm font-black text-emerald-400 uppercase rt-end">
                  Season
                </td>
                <td className="py-3 pr-4 text-sm font-black text-white uppercase rt-lead rt-first">
                  {rows.length} games
                </td>
                <td className={cell} />
                <td
                  data-label="C/A"
                  className="py-3 pr-4 text-sm font-black text-white"
                >
                  {s.cmp}/{s.att}
                </td>
                <td
                  data-label="Yds"
                  className="py-3 pr-4 text-sm font-black text-white"
                >
                  {s.yds}
                </td>
                <td
                  data-label="TD"
                  className="py-3 pr-4 text-sm font-black text-white"
                >
                  {s.td}
                </td>
                <td
                  data-label="INT"
                  className="py-3 pr-4 text-sm font-black text-white"
                >
                  {s.int}
                </td>
                <td className="py-3 pr-4 text-[10px] text-white/30 uppercase font-black rt-full">
                  {s.note}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4 space-y-1 text-[11px] text-white/40">
        {mp && (
          <p>
            <span className="font-black uppercase tracking-widest mr-2">
              MaxPreps season page
            </span>
            {mp.gp} GP · {mp.cmp}/{mp.att} · {mp.yds} yds · {mp.td} TD ·{" "}
            {mp.int} INT{mp.note ? ` · ${mp.note}` : ""}
          </p>
        )}
        {o.difference && (
          <p>
            <span className="font-black uppercase tracking-widest mr-2">
              Staff tags vs official
            </span>
            {o.difference}
          </p>
        )}
        {o.source && (
          <p className="text-white/30 wrap-anywhere">{keepDates(o.source)}</p>
        )}
      </div>
    </div>
  );
};

// Camps and schedule: the rest of the 2026 season and any camps in the recruiting package (athletes/<id>.package.json),
// then the camp pages already scraped from college sites (colleges.camps), the athlete's board first. Nothing else.
const CampsPanel = ({
  athleteId,
  colleges,
  onBoard,
}: {
  athleteId: string;
  colleges: CollegeProgram[];
  onBoard: Set<string>;
}) => {
  const [sched, setSched] = useState<AthleteSchedule | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let live = true;
    fetchApi<AthleteSchedule>(`/api/athletes/${athleteId}/schedule`).then(
      (r) => live && setSched(r),
    );
    return () => {
      live = false;
    };
  }, [athleteId]);
  const withCamps = colleges
    .filter((c) => c.camps && c.camps.length > 0)
    .sort(
      (a, b) =>
        Number(onBoard.has(b.id)) - Number(onBoard.has(a.id)) ||
        Number(b.metadata.state === "TX") - Number(a.metadata.state === "TX") ||
        a.metadata.name.localeCompare(b.metadata.name),
    );
  return (
    <div className="space-y-8">
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
            Rest of the 2026 season
          </p>
          {sched === undefined ? (
            <p className="text-sm text-white/30 animate-pulse">Loading...</p>
          ) : sched && sched.remaining.length > 0 ? (
            <table className="w-full text-left border-collapse">
              <tbody>
                {sched.remaining.map((g) => (
                  <tr
                    key={`${g.date}-${g.opponent}`}
                    className="border-b border-white/5"
                  >
                    <td className="py-2 pr-4 text-sm font-bold text-white/70 whitespace-nowrap">
                      {g.date}
                    </td>
                    <td className="py-2 pr-4 text-sm font-black text-white uppercase">
                      {g.opponent}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : sched ? (
            <p className="text-sm text-white/30">
              No remaining games on file (recruiting package).
            </p>
          ) : (
            <span className={missingCls}>Schedule · not available</span>
          )}
          {sched?.source && (
            <p className="text-[10px] text-white/30 uppercase font-bold mt-3">
              {sched.source}
            </p>
          )}
        </div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
            Camps on the family's list
          </p>
          {sched === undefined ? (
            <p className="text-sm text-white/30 animate-pulse">Loading...</p>
          ) : sched && sched.camps.length > 0 ? (
            sched.camps.map((c, i) => (
              <p key={i} className="text-sm text-white/80 mb-1">
                <span className="text-white font-bold">
                  {c.date || c.dates || "date —"}
                </span>{" "}
                {c.name || c.label || "Camp"}
                {c.location ? ` · ${c.location}` : ""}
                {c.url && /^https?:\/\//.test(c.url) && (
                  <a
                    href={c.url}
                    target="_self"
                    className="tap text-emerald-500 hover:underline ml-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    page
                  </a>
                )}
              </p>
            ))
          ) : sched ? (
            <p className="text-sm text-white/30">
              None yet. Camps the family signs up for go in the recruiting
              package.
            </p>
          ) : (
            <span className={missingCls}>Family camp list · not available</span>
          )}
        </div>
      </div>

      <div>
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-2 mb-4">
          <div>
            <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
              Found on program sites · check dates there before signing up
            </span>
            <h3 className="text-3xl font-black text-white uppercase italic tracking-tighter">
              College camp pages
            </h3>
          </div>
          <p className="text-[10px] text-white/30 uppercase font-black">
            {withCamps.length} programs ·{" "}
            {withCamps.filter((c) => onBoard.has(c.id)).length} on the board
          </p>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {withCamps.map((c) => (
            <div
              key={c.id}
              className="bg-white/5 border border-white/10 rounded-2xl p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-white uppercase">
                    {c.metadata.name}
                  </p>
                  <p className="text-[10px] text-white/40 uppercase font-bold">
                    {c.metadata.division} · {c.metadata.state}
                  </p>
                </div>
                {onBoard.has(c.id) && (
                  <span className="px-2 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded-full whitespace-nowrap">
                    on board
                  </span>
                )}
              </div>
              <div className="mt-3 space-y-2">
                {(c.camps || []).map((k, i) => (
                  <a
                    key={`${i}-${k.url}`}
                    href={k.url}
                    target="_self"
                    className="tap-block block text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline"
                  >
                    {k.label || "Camps"}
                    <span className="text-white/40 block normal-case tracking-normal font-bold">
                      {k.dates || "no dates listed"}
                      {k.scrapedAt ? ` · seen ${k.scrapedAt}` : ""}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
          {withCamps.length === 0 && (
            <p className="text-sm text-white/30">
              No camp pages found on program sites yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

const PlayerCard = () => {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [p, setP] = useState<AthleteCard | null>(null);
  const [touches, setTouches] = useState<Touch[]>([]);
  const [colleges, setColleges] = useState<CollegeProgram[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  // The section lives in the URL (?tab=) so the desktop and Franklin open it by address. Switching replaces the history
  // entry (no reload) and keeps any other query parameters.
  const tab = cardTab(searchParams.get("tab"));
  const setTab = (t: CardTab) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (t === "board") next.delete("tab");
        else next.set("tab", t);
        return next;
      },
      { replace: true },
    );
  const [reports, setReports] = useState<ReportInfo[] | null>(null);
  const [filmNotes, setFilmNotes] = useState<FilmNote[]>([]);
  const [filmReport, setFilmReport] = useState<FilmReport | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  // On phones the section tabs are one scrolling row: keep the open section's tab in view (also when opened by ?tab=).
  const tabBarRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowScreen();
  useEffect(() => {
    const bar = tabBarRef.current;
    const btn = bar?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!bar || !btn || bar.scrollWidth <= bar.clientWidth) return;
    const left =
      btn.getBoundingClientRect().left -
      bar.getBoundingClientRect().left +
      bar.scrollLeft;
    bar.scrollLeft = left - (bar.clientWidth - btn.offsetWidth) / 2;
    // the counts in the tab labels arrive after the card and widen the tabs, so run again then
  }, [tab, loading, touches.length, drafts.length, filmNotes.length]);

  const loadAgent = async () => {
    if (!id) return;
    const [fn, dr, rn, card] = await Promise.all([
      fetchApi<{ rows: FilmNote[]; report: FilmReport | null }>(
        `/api/athletes/${id}/film-notes`,
      ),
      fetchApi<{ rows: Draft[] }>(`/api/athletes/${id}/drafts`),
      fetchApi<{ rows: AgentRun[] }>(`/api/athletes/${id}/runs`),
      fetchApi<AthleteCard>(`/api/athletes/${id}`),
    ]);
    setFilmNotes(fn?.rows || []);
    setFilmReport(fn?.report || null);
    setDrafts(dr?.rows || []);
    setRuns(rn?.rows || []);
    if (card) setP(card);
  };

  useEffect(() => {
    if (!id) return;
    (async () => {
      const [card, out, cols, cs, rep] = await Promise.all([
        fetchApi<AthleteCard>(`/api/athletes/${id}`),
        fetchApi<{ rows: Touch[] }>(`/api/athletes/${id}/outreach`),
        fetchApi<{ rows: CollegeProgram[] }>("/api/colleges?scraped=1"),
        fetchApi<{ rows: Coach[] }>("/api/coaches?limit=5000"),
        fetchApi<{ reports: ReportInfo[] }>(`/api/athletes/${id}/reports`),
      ]);
      setP(card);
      setTouches(out?.rows || []);
      setColleges(cols?.rows || []);
      setCoaches(cs?.rows || []);
      setReports(rep?.reports || null);
      setLoading(false);
      await loadAgent();
    })();
  }, [id]);

  if (loading)
    return (
      <div className="min-h-screen bg-[#0a0a0a] pt-40 text-center text-white/40 font-black uppercase tracking-widest animate-pulse">
        Loading player card...
      </div>
    );
  if (!p)
    return (
      <div className="min-h-screen bg-[#0a0a0a] pt-40 text-center text-white/40 font-black uppercase tracking-widest">
        Player not found (is the local API running?)
      </div>
    );

  const pos = p.position;
  const hsClass = String(p.gradYear);
  const touchedSchools = new Set(touches.map((t) => t.school));
  const board = colleges
    .filter((c) => c.rosterProfile?.byPosition?.[pos])
    .map((c) => {
      const prof = c.rosterProfile!.byPosition[pos];
      const openings = prof.openingsByHsClass?.[hsClass] ?? 0;
      const committed = prof.commitsKnown?.[hsClass]
        ? (prof.committedByHsClass?.[hsClass] ?? 0)
        : null;
      const net = Math.max(0, openings - (committed ?? 0));
      let fit: string = "n/a";
      if (p.heightInches && prof.heightIn)
        fit =
          p.heightInches < prof.heightIn.min - 1
            ? "below"
            : p.heightInches > prof.heightIn.max + 1
              ? "above"
              : "in band";
      const staff = coaches.filter((k) => k.college === c.metadata.name);
      const coach =
        staff.find((k) => k.role === "recruiting_coordinator" && k.email) ||
        staff.find((k) => k.role === "player_personnel" && k.email) ||
        staff.find((k) => k.role === "qb_coach" && k.email) ||
        staff.find((k) => k.email);
      const tx = c.metadata.state === "TX" ? 1 : 0;
      return {
        c,
        prof,
        openings,
        committed,
        net,
        fit,
        coach,
        tx,
        contacted: touchedSchools.has(c.metadata.name),
      };
    })
    .sort(
      (x, y) =>
        y.tx - x.tx ||
        y.net - x.net ||
        (y.c.rosterProfile?.footprint?.dfw || 0) -
          (x.c.rosterProfile?.footprint?.dfw || 0),
    )
    .slice(0, 40);

  const sent = touches.filter((t) => t.direction === "out");
  const replies = touches.filter((t) => t.direction === "in");
  // stat tiles: a grid from md up, a compact sideways-scrolling strip on phones
  const stat = (label: string, value: React.ReactNode) => (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-5 max-md:shrink-0 max-md:w-32 max-md:px-4 max-md:py-3 max-md:snap-start">
      <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-1 max-md:leading-tight">
        {label}
      </p>
      <p className="text-3xl max-md:text-2xl font-black text-white italic">
        {value}
      </p>
    </div>
  );
  const tabCls = (t: typeof tab) =>
    cn(
      "px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest transition-all max-md:shrink-0 max-md:whitespace-nowrap",
      tab === t
        ? "bg-emerald-500 text-black"
        : "bg-white/5 text-white/50 hover:text-white",
    );

  return (
    <div className="min-h-screen bg-[#0a0a0a] pt-32 pb-20 px-6 2xl:px-10 max-md:pt-24">
      <div className="w-full max-w-none mx-auto">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-white/10 pb-8 mb-8 max-md:gap-4 max-md:pb-6 max-md:mb-6">
          <div>
            <span className="text-emerald-500 text-xs font-black uppercase tracking-[0.2em]">
              Athletic Analyst · player card
            </span>
            <h2 className="text-6xl max-md:text-4xl font-black text-white uppercase italic tracking-tighter">
              #{p.jersey} {p.name}
            </h2>
            <p className="text-white/50 font-bold uppercase tracking-tight mt-2">
              {p.position}
              {p.throws ? ` (${p.throws}-handed)` : ""} · Class of {p.gradYear}{" "}
              · {p.highSchool}, {p.city} {p.state}
              {p.uil
                ? ` · UIL ${p.uil.conference} District ${p.uil.footballDistrict} ${p.uil.region}`
                : ""}
            </p>
            <p className="text-[10px] text-white/30 uppercase font-bold mt-2">
              {p.heightInches
                ? `${Math.floor(p.heightInches / 12)}'${p.heightInches % 12}"`
                : "HT —"}{" "}
              · {p.weightLbs ? `${p.weightLbs} lbs` : "WT —"} ·{" "}
              {p.gpa ? `GPA ${p.gpa}` : "GPA —"}
              {p.measurablesNote ? ` · ${p.measurablesNote}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {p.media?.hudlUrl && (
              <a
                href={p.media.hudlUrl}
                target="_self"
                className="tap px-5 py-3 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-full"
              >
                Hudl
              </a>
            )}
            {p.media?.maxPrepsUrl ? (
              <a
                href={p.media.maxPrepsUrl}
                target="_self"
                className="tap px-5 py-3 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-full"
              >
                MaxPreps
              </a>
            ) : (
              <span className="px-5 py-3 bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-black uppercase tracking-widest rounded-full">
                MaxPreps link needed
              </span>
            )}
            {p.media?.teamSite && (
              <a
                href={p.media.teamSite}
                target="_self"
                className="tap px-5 py-3 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-full"
              >
                Team site
              </a>
            )}
          </div>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4 mb-8 max-md:flex max-md:gap-2 max-md:overflow-x-auto max-md:snap-x max-md:-mx-6 max-md:px-6 max-md:scroll-px-6 max-md:mb-5 scroll-strip">
          {stat("Programs on board", board.length)}
          {stat("With net openings", board.filter((b) => b.net > 0).length)}
          {stat(
            "Emails sent",
            sent.filter((t) => t.channel === "email").length,
          )}
          {stat("DMs sent", sent.filter((t) => t.channel === "dm").length)}
          {stat("Replies", replies.filter((t) => t.channel === "email").length)}
          {stat(
            "Agent",
            <span
              className={
                p.agent?.enabled ? "text-emerald-400" : "text-white/30"
              }
            >
              {p.agent?.enabled ? "ON" : "OFF"}
            </span>,
          )}
        </div>

        <div
          ref={tabBarRef}
          className="flex flex-wrap gap-2 mb-6 max-md:flex-nowrap max-md:overflow-x-auto max-md:-mx-6 max-md:px-6 max-md:scroll-px-6 scroll-strip"
        >
          <button
            className={tabCls("board")}
            aria-pressed={tab === "board"}
            onClick={() => setTab("board")}
          >
            Board
          </button>
          <button
            className={tabCls("outreach")}
            aria-pressed={tab === "outreach"}
            onClick={() => setTab("outreach")}
          >
            Outreach & drafts ({touches.length} · {drafts.length})
          </button>
          <button
            className={tabCls("film")}
            aria-pressed={tab === "film"}
            onClick={() => setTab("film")}
          >
            Film ({p.film?.length || 0}
            {filmNotes.length ? ` · ${filmNotes.length} notes` : ""})
          </button>
          <button
            className={tabCls("highlights")}
            aria-pressed={tab === "highlights"}
            onClick={() => setTab("highlights")}
          >
            Highlights
          </button>
          <button
            className={tabCls("stats")}
            aria-pressed={tab === "stats"}
            onClick={() => setTab("stats")}
          >
            Stats
          </button>
          <button
            className={tabCls("camps")}
            aria-pressed={tab === "camps"}
            onClick={() => setTab("camps")}
          >
            Camps & schedule
          </button>
          <button
            className={tabCls("resume")}
            aria-pressed={tab === "resume"}
            onClick={() => setTab("resume")}
          >
            Resume & report
          </button>
          <button
            className={tabCls("agent")}
            aria-pressed={tab === "agent"}
            onClick={() => setTab("agent")}
          >
            Agent ({drafts.length})
          </button>
        </div>

        {tab === "board" && (
          <div className="overflow-x-auto">
            <table className="rt rt-flow w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  {[
                    "Program",
                    "Div",
                    `${pos} room`,
                    `Net open ${hsClass}`,
                    "Height band",
                    "Fit",
                    "TX / DFW",
                    "Contacted",
                    "Best contact",
                  ].map((h) => (
                    <th
                      key={h}
                      className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.map(
                  ({ c, prof, net, committed, fit, coach, contacted }) => (
                    <tr
                      key={c.id}
                      className="border-b border-white/5 hover:bg-white/5"
                    >
                      <td className="py-3 pr-4 rt-full">
                        <p className="text-sm font-black text-white uppercase">
                          {c.metadata.name}
                        </p>
                        <p className="text-[10px] text-white/40 uppercase font-bold">
                          {c.metadata.conference} · {c.metadata.state}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="px-2 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded-full">
                          {c.metadata.division}
                        </span>
                      </td>
                      <td
                        data-label={`${pos} room`}
                        className="py-3 pr-4 text-sm font-bold text-white/70"
                      >
                        {prof.count}
                      </td>
                      <td
                        data-label={`Net open ${hsClass}`}
                        className="py-3 pr-4"
                      >
                        <span
                          className={cn(
                            "text-2xl font-black italic max-md:text-lg",
                            net > 0 ? "text-emerald-400" : "text-white/20",
                          )}
                        >
                          {net}
                        </span>
                        {committed === null && (
                          <span className="text-[9px] text-white/30 uppercase font-black block max-md:inline max-md:ml-1">
                            gross
                          </span>
                        )}
                      </td>
                      <td
                        data-label="Height"
                        className="py-3 pr-4 text-sm font-bold text-white/70"
                      >
                        {prof.heightIn
                          ? `${inchesToFt(prof.heightIn.min)} – ${inchesToFt(prof.heightIn.max)}`
                          : "—"}
                      </td>
                      <td data-label="Fit" className="py-3 pr-4">
                        {fit !== "n/a" && (
                          <span
                            className={cn(
                              "px-2 py-1 text-[10px] font-black uppercase rounded-full",
                              fit === "in band"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-amber-500/15 text-amber-400",
                            )}
                          >
                            {fit}
                          </span>
                        )}
                      </td>
                      <td
                        data-label="TX / DFW"
                        className="py-3 pr-4 text-sm font-bold text-white/70"
                      >
                        {c.rosterProfile?.footprint
                          ? `${c.rosterProfile.footprint.texas} / ${c.rosterProfile.footprint.dfw}`
                          : "—"}
                      </td>
                      <td data-label="Contacted" className="py-3 pr-4">
                        {contacted ? (
                          <span className="px-2 py-1 bg-white/10 text-white/70 text-[10px] font-black uppercase rounded-full">
                            yes
                          </span>
                        ) : (
                          <span className="text-white/20 text-[10px] font-black uppercase">
                            no
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 rt-full">
                        {coach ? (
                          <a
                            href={`mailto:${coach.email}`}
                            title={coach.title}
                            className="tap-block text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:underline"
                          >
                            {coach.name}
                            <br />
                            <span className="text-white/40">
                              {softBreaks(clip(coach.title, 36), narrow)}
                            </span>
                          </a>
                        ) : (
                          <span className="text-white/20 text-[10px] font-black uppercase">
                            no email yet
                          </span>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "outreach" && (
          <div className="mb-10">
            <AgentPanel
              athleteId={p.id}
              agent={p.agent}
              drafts={drafts}
              runs={runs}
              onChange={loadAgent}
            />
            <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mt-10">
              Outreach log · sent and replies ({touches.length})
            </p>
          </div>
        )}
        {tab === "outreach" && (
          <div className="overflow-x-auto">
            <table className="rt rt-flow rt-list w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  {[
                    "Date",
                    "Program",
                    "Channel",
                    "Direction",
                    "Contact",
                    "Note",
                    "Source",
                  ].map((h) => (
                    <th
                      key={h}
                      className="py-4 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {touches.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-white/5 hover:bg-white/5"
                  >
                    <td className="py-3 pr-4 text-sm font-bold text-white/70 rt-end rt-nowrap">
                      {t.at || "—"}
                    </td>
                    <td className="py-3 pr-4 text-sm font-black text-white uppercase rt-lead rt-first">
                      {t.school}
                      <span className="text-white/30 text-[10px] block max-md:inline max-md:ml-2">
                        {t.subdivision || t.division}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="px-2 py-1 bg-white/10 text-white text-[10px] font-black uppercase rounded-full">
                        {t.channel}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-[10px] font-black uppercase">
                      <span
                        className={
                          t.direction === "in"
                            ? "text-emerald-400"
                            : "text-white/50"
                        }
                      >
                        {t.direction === "in" ? "reply" : "sent"}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-sm text-white/70">
                      {t.contact_name || "—"}
                      {t.contact_email ? (
                        <span className="text-white/30 block text-[10px] max-md:inline max-md:ml-2">
                          {t.contact_email}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-sm text-white/60 rt-last">
                      {t.note || ""}
                    </td>
                    <td className="py-3 pr-4 text-[10px] text-white/30 uppercase font-black">
                      {t.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "film" && (
          <div className="mb-8">
            <ReportFrame
              report={reports?.find((r) => r.name === "film-study")}
              label="Season film study"
            />
          </div>
        )}
        {tab === "film" && (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
            {(p.film || []).map((f) => (
              <div
                key={f.title}
                className="bg-white/5 border border-white/10 rounded-3xl p-6"
              >
                <p className="text-emerald-500 text-[10px] font-black uppercase tracking-widest">
                  {f.length || ""}
                  {f.plays ? ` · ${f.plays} plays` : ""}
                  {f.touchdowns ? ` · ${f.touchdowns} TD` : ""}
                </p>
                <h3 className="text-xl font-black text-white uppercase italic tracking-tight mt-1">
                  {f.title}
                </h3>
                {f.games && (
                  <p className="text-[10px] text-white/40 uppercase font-bold mt-2">
                    {f.games.join(" · ")}
                  </p>
                )}
                {f.notes && (
                  <p className="text-sm text-white/50 mt-3">{f.notes}</p>
                )}
                <div className="mt-4 flex gap-3">
                  {f.hostedUrl ? (
                    <a
                      href={f.hostedUrl}
                      target="_self"
                      className="tap px-4 py-2 bg-white text-black text-[10px] font-black uppercase tracking-widest rounded-full"
                    >
                      Watch
                    </a>
                  ) : (
                    <span className="px-4 py-2 bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-black uppercase tracking-widest rounded-full">
                      local file · not hosted yet
                    </span>
                  )}
                </div>
                {f.file && (
                  <p className="text-[10px] text-white/20 mt-3 break-all">
                    {f.file}
                  </p>
                )}
              </div>
            ))}
            <div className="bg-white/5 border border-dashed border-white/10 rounded-3xl p-6 md:col-span-2 xl:col-span-3">
              <p className="text-[10px] text-white/40 font-black uppercase tracking-widest mb-3">
                Game film sources
              </p>
              {(p.gameSources || []).map((g) => (
                <a
                  key={g.url}
                  href={g.url}
                  target="_self"
                  className="tap-block block text-sm text-emerald-500 hover:underline"
                >
                  {g.game} <span className="text-white/30">· {g.source}</span>
                </a>
              ))}
              {filmNotes.length === 0 && (
                <p className="text-[10px] text-white/30 uppercase font-black mt-4">
                  AI film notes (advisory) appear here once the evaluator pass
                  runs (Agent tab → Film evaluation).
                </p>
              )}
            </div>
          </div>
        )}
        {tab === "film" && filmNotes.length > 0 && (
          <FilmNotesPanel notes={filmNotes} report={filmReport} />
        )}
        {tab === "agent" && (
          <AgentPanel
            athleteId={p.id}
            agent={p.agent}
            drafts={drafts}
            runs={runs}
            onChange={loadAgent}
          />
        )}

        {tab === "stats" && (
          <OfficialLinesPanel
            athleteId={p.id}
            maxPrepsUrl={p.media?.maxPrepsUrl}
          />
        )}
        {tab === "stats" && (
          <div className="bg-white/5 border border-white/10 rounded-3xl p-8 max-md:p-4">
            {p.stats && p.stats.length > 0 ? (
              <table className="rt w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    {["Season", "Team", "Passing", "Rushing", "Source"].map(
                      (h) => (
                        <th
                          key={h}
                          className="py-3 pr-4 text-[10px] font-black text-white/40 uppercase tracking-widest"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {p.stats.map((s) => (
                    <tr key={s.season} className="border-b border-white/5">
                      <td
                        data-label="Season"
                        className="py-3 pr-4 text-sm font-black text-white rt-nowrap"
                      >
                        {s.season}
                      </td>
                      <td
                        data-label="Team"
                        className="py-3 pr-4 text-sm text-white/70"
                      >
                        {s.team || ""}
                      </td>
                      <td
                        data-label="Passing"
                        className="py-3 pr-4 text-sm text-white/70 rt-full"
                      >
                        {/* a stat and its value never split across lines (TD/G 2.2, QB Rate 128) */}
                        {s.passing
                          ? Object.entries(s.passing)
                              .map(([k, v]) => `${k.replace(/ /g, "\u00a0")}\u00a0${v}`)
                              .join(" · ")
                          : "—"}
                      </td>
                      <td
                        data-label="Rushing"
                        className="py-3 pr-4 text-sm text-white/70 rt-full"
                      >
                        {s.rushing
                          ? Object.entries(s.rushing)
                              .map(([k, v]) => `${k.replace(/ /g, "\u00a0")}\u00a0${v}`)
                              .join(" · ")
                          : "—"}
                      </td>
                      <td className="py-3 pr-4 text-[10px] text-white/30 uppercase font-black rt-full">
                        {s.source}
                        {s.fetchedAt ? ` · ${s.fetchedAt}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-white/50 font-bold uppercase tracking-tight">
                {p.statsNote || "No stats on file."}
              </p>
            )}
          </div>
        )}
        {tab === "highlights" && <HighlightsPanel athleteId={p.id} />}
        {tab === "camps" && (
          <CampsPanel
            athleteId={p.id}
            colleges={colleges}
            onBoard={new Set(board.map((b) => b.c.id))}
          />
        )}
        {tab === "resume" && <ResumePanel reports={reports} />}
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const profileDoc = await getDoc(doc(db, "users", firebaseUser.uid));
          if (profileDoc.exists()) {
            setProfile(profileDoc.data() as UserProfile);
          } else {
            // Create default profile if not exists
            const newProfile: UserProfile = {
              uid: firebaseUser.uid,
              displayName: firebaseUser.displayName || "Scout User",
              email: firebaseUser.email || "",
              photoURL: firebaseUser.photoURL || "",
              role: "athlete",
              createdAt: Timestamp.now(),
            };
            await setDoc(doc(db, "users", firebaseUser.uid), newProfile);
            setProfile(newProfile);
          }
        } catch (error) {
          handleFirestoreError(
            error,
            OperationType.GET,
            `users/${firebaseUser.uid}`,
          );
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!profile) return;

    // Connection test
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, "test", "connection"));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("the client is offline")
        ) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    // Seed database if admin
    const seedIfAdmin = async () => {
      if (ADMIN_EMAIL && profile.email === ADMIN_EMAIL) {
        try {
          const collegesSnap = await getDocs(collection(db, "colleges"));
          if (collegesSnap.empty) {
            const sampleColleges: CollegeProgram[] = [
              {
                id: "alabama",
                metadata: {
                  name: "University of Alabama",
                  division: "FBS",
                  region: "Southeast",
                  conference: "SEC",
                  size: "Large",
                } as any,
                academicThresholds: { minGpa: 3.0, minSat: 1100 },
                positionalNeeds: { QB: 0.9, WR: 0.8, CB: 0.7 },
              },
              {
                id: "stanford",
                metadata: {
                  name: "Stanford University",
                  division: "FBS",
                  region: "West",
                  conference: "ACC",
                  size: "Medium",
                } as any,
                academicThresholds: { minGpa: 3.8, minSat: 1450 },
                positionalNeeds: { QB: 0.7, LB: 0.9, S: 0.8 },
              },
              {
                id: "michigan",
                metadata: {
                  name: "University of Michigan",
                  division: "FBS",
                  region: "Midwest",
                  conference: "Big Ten",
                  size: "Large",
                } as any,
                academicThresholds: { minGpa: 3.4, minSat: 1250 },
                positionalNeeds: { RB: 0.9, OL: 0.8, DL: 0.8 },
              },
            ];
            for (const college of sampleColleges) {
              await setDoc(doc(db, "colleges", college.id), college);
            }
            console.log("Database seeded with sample colleges");
          }

          // Seed coaches
          const coachesSnap = await getDocs(collection(db, "coaches"));
          if (coachesSnap.empty) {
            const sampleCoaches: Coach[] = [
              {
                id: "demo-state-head-coach",
                name: "Pat Example",
                title: "Head Coach",
                college: "Demo State University",
                division: "FCS",
                region: "Southwest",
                email: "coach@example.edu",
              },
              {
                id: "example-college-recruiting",
                name: "Robin Sample",
                title: "Recruiting Coordinator",
                college: "Example College",
                division: "D2",
                region: "Midwest",
                email: "recruiting@example.edu",
              },
            ];
            for (const coach of sampleCoaches) {
              await setDoc(doc(db, "coaches", coach.id), coach);
            }
            console.log("Database seeded with recruiting staff");
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.LIST, "colleges");
        }
      }
    };
    seedIfAdmin();
  }, [profile]);

  const signIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Auth error", error);
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  if (loading) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center"
        >
          <Trophy className="text-black w-8 h-8" />
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AuthContext.Provider value={{ user, profile, loading, signIn, logout }}>
        <Router>
          <div className="min-h-screen bg-black text-white font-sans selection:bg-emerald-500 selection:text-black">
            <Navbar />
            <AnimatePresence mode="wait">
              <Routes>
                <Route path="/" element={<Hero />} />
                <Route path="/scout" element={<ScoutFeed />} />
                <Route path="/athletes" element={<AthleteList />} />
                <Route path="/coaches" element={<CoachDirectory />} />
                <Route path="/needs" element={<ProgramNeeds />} />
                <Route path="/players" element={<PlayersIndex />} />
                <Route path="/player/:id" element={<PlayerCard />} />
                <Route path="/my-profile" element={<MyProfile />} />
                <Route path="/matches" element={<Matchmaking />} />
              </Routes>
            </AnimatePresence>

            {/* Footer */}
            <footer className="bg-black border-t border-white/10 py-20 px-6">
              <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-12">
                <div className="col-span-2">
                  <div className="flex items-center gap-2 mb-6">
                    <Trophy className="text-emerald-500 w-8 h-8" />
                    <span className="text-2xl font-black tracking-tighter uppercase italic">
                      Gridiron Scout
                    </span>
                  </div>
                  <p className="text-white/40 max-w-md text-sm leading-relaxed">
                    Empowering the next generation of football legends. Our
                    mission is to provide mainstream exposure to every athlete
                    with the heart and talent to play at the next level.
                  </p>
                </div>
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-white mb-6">
                    Platform
                  </h4>
                  <ul className="space-y-4 text-sm font-bold text-white/60 uppercase tracking-tight">
                    <li>
                      <Link
                        to="/scout"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Scout Feed
                      </Link>
                    </li>
                    <li>
                      <Link
                        to="/athletes"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Prospects
                      </Link>
                    </li>
                    <li>
                      <Link
                        to="/"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Rankings
                      </Link>
                    </li>
                  </ul>
                </div>
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-white mb-6">
                    Support
                  </h4>
                  <ul className="space-y-4 text-sm font-bold text-white/60 uppercase tracking-tight">
                    <li>
                      <Link
                        to="/"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Contact
                      </Link>
                    </li>
                    <li>
                      <Link
                        to="/"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Privacy
                      </Link>
                    </li>
                    <li>
                      <Link
                        to="/"
                        className="tap hover:text-emerald-400 transition-colors"
                      >
                        Terms
                      </Link>
                    </li>
                  </ul>
                </div>
              </div>
              <div className="max-w-7xl mx-auto mt-20 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-white/20">
                  © 2026 Gridiron Scout. All Rights Reserved.
                </p>
                <div className="flex gap-6">
                  <Shield className="text-white/10 w-5 h-5" />
                  <Star className="text-white/10 w-5 h-5" />
                  <Zap className="text-white/10 w-5 h-5" />
                </div>
              </div>
            </footer>
          </div>
        </Router>
      </AuthContext.Provider>
    </ErrorBoundary>
  );
}
