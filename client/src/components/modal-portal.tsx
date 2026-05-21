import { ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children at document.body level via portal, with:
 *   - a backdrop that calls onClose on click
 *   - body scroll lock while open
 *   - centered flex container with mobile-safe padding
 *
 * Use this instead of inline `fixed inset-0` modal wrappers. Inline
 * fixed-position modals get mispositioned on iOS Safari when an
 * ancestor has been transformed (which our slide-out panels +
 * page-fade-in animations do). The portal escapes that.
 *
 * Backdrop opacity defaults to /60; pass `dim="opaque"` for /70.
 */
export function ModalPortal({
  children,
  onClose,
  dim = "soft",
}: {
  children: ReactNode;
  onClose: () => void;
  dim?: "soft" | "opaque";
}) {
  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto ${dim === "opaque" ? "bg-black/70" : "bg-black/60"} backdrop-blur-[2px]`}
      onClick={onClose}
    >
      {children}
    </div>,
    document.body,
  );
}
