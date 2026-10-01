export type UserRole = "USER" | "DEPARTMENT_ADMIN" | "ADMIN";
export type PageVisibility = "PRIVATE" | "DEPARTMENT" | "COMPANY";
export type PagePermission = "READ" | "EDIT";
export type TemplateScope = "PRIVATE" | "DEPARTMENT" | "COMPANY";

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  departmentId: string;
}

export interface PageBlock {
  id: string;
  type: "paragraph" | "heading" | "image" | "video" | "link" | "table" | "file" | "callout";
  data: Record<string, unknown>;
}

export interface PageSummary {
  id: string;
  title: string;
  visibility: PageVisibility;
  version: number;
  ownerId: string;
  departmentId: string;
  parentId: string | null;
  updatedAt: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
