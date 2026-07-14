import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Company = "fitscript" | "peptideu";

interface CompanyState {
  company: Company;
  setCompany: (c: Company) => void;
}

const CompanyContext = createContext<CompanyState>({ company: "fitscript", setCompany: () => {} });

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [company, setCompanyState] = useState<Company>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("ops-company") as Company) || "fitscript";
    }
    return "fitscript";
  });

  useEffect(() => { localStorage.setItem("ops-company", company); }, [company]);

  return (
    <CompanyContext.Provider value={{ company, setCompany: setCompanyState }}>
      {children}
    </CompanyContext.Provider>
  );
}

export const useCompany = () => useContext(CompanyContext);
