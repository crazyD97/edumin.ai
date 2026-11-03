export interface Branding {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  loginTitle?: string | null;
  loginSubtitle?: string | null;
  loginImageUrl?: string | null;
  reportCardHeader?: string | null;
  reportCardFooter?: string | null;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  principalName?: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  primaryColor: '#4f46e5',
  secondaryColor: '#0f172a',
  accentColor: '#f59e0b',
};

export interface SchoolSettings {
  admissionNoFormat: string; // tokens: {YYYY} {YY} {SEQ:n}
  receiptNoFormat: string;
  applicationNoFormat: string;
  lowAttendanceThreshold: number; // percent
  currency: string;
  timezone: string;
  workingDays: number[]; // 1..6
}

export const DEFAULT_SETTINGS: SchoolSettings = {
  admissionNoFormat: 'ADM{YYYY}{SEQ:4}',
  receiptNoFormat: 'RCT{YY}{SEQ:6}',
  applicationNoFormat: 'APP{YYYY}{SEQ:4}',
  lowAttendanceThreshold: 75,
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  workingDays: [1, 2, 3, 4, 5, 6],
};
