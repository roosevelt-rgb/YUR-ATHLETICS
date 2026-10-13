/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional admin account for the Coaches import and the first-run seed. */
  readonly VITE_ADMIN_EMAIL?: string;
  /** Optional Hudl team library the highlight clip links open. */
  readonly VITE_HUDL_TEAM_ID?: string;
}
