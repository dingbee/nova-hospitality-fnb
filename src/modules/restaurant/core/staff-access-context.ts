import { createContext, useContext } from "react";

export type StaffAccessSessionValue = {
  sessionId: string | null;
  staffUserId: string | null;
  staffMemberId: string | null;
  role: string | null;
  propertyId: string | null;
};

export const StaffAccessSessionContext = createContext<StaffAccessSessionValue>({
  sessionId: null,
  staffUserId: null,
  staffMemberId: null,
  role: null,
  propertyId: null,
});

export const useStaffAccessSession = () => useContext(StaffAccessSessionContext);

export function clearStaffAccessSessionCookie() {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `lexibite_staff_session=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
}
