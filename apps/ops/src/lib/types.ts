/** Shapes of the API responses the panel reads (only the fields it uses). */
export interface Hub {
  id: string;
  code: string;
  name: string;
  district: string;
  zone?: string | null;
  address: string;
  active: boolean;
  type?: string;
  capacity?: number | null;
  lat?: number | null;
  lng?: number | null;
  inChargeName?: string | null;
  inChargePhone?: string | null;
  [key: string]: unknown;
}

export interface Rider {
  id: string;
  code: string;
  name: string;
  phone: string;
  label: string;
  vehicle: string;
  zone: string | null;
  status: string;
  active: boolean;
  dailyCapacity: number | null;
  hub: { id: string; name: string; code: string; type?: string } | null;
  openTasks?: number;
}

export interface OpsCan {
  dispatch: boolean;
  manageHubs: boolean;
  manageRiders: boolean;
  readRiders: boolean;
  receiveCash: boolean;
  financeStaff: boolean;
  manageFinance: boolean;
  financeSettings: boolean;
  manageConfig: boolean;
  merchantAddress: boolean;
  loginAs: boolean;
  loginAsFull: boolean;
}

export interface OpsMe {
  roles: string[];
  hubIds: string[] | null;
  hubs: { id: string; name: string }[] | null;
  can: OpsCan;
}

export interface OpsAlert {
  kind: string;
  tone: "red" | "amber";
  icon: string;
  title: string;
  text: string;
  meta: string;
  at: string | null;
  action: { exception?: string; page?: string; label: string };
}

export interface OpsOverview {
  generatedAt: string;
  me: OpsMe;
  shipments: Record<string, number> & { byStatus: Record<string, number> };
  serviceLines: Record<string, number>;
  onTime: { monthRate: number | null; monthDelivered: number; previousMonthRate: number | null };
  riders: { online: number; onBreak: number; offline: number; total: number; withOpenTasks: number };
  hubs: (Hub & { atHub: number; inbound: number; awaitingDispatch: number; inboundToday: number; outboundToday: number })[];
  cash: { withRiders: number; collections: number; oldestCollectedAt: string | null } | null;
  alerts: OpsAlert[];
  period: { from: string; to: string; label?: string; [key: string]: unknown };
  metrics: Record<string, unknown>;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
