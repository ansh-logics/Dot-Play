import React, { forwardRef, useMemo } from "react";
import { Glass, type GlassOptics } from "@samasante/liquid-glass";
import { useReducedMotion } from "motion/react";
import "./LiquidGlassSurface.css";

export type LiquidGlassVariant = "button" | "play" | "popover" | "menu" | "toast";

export const COMPACT_BUTTON_OPTICS: Partial<GlassOptics> = {
  mapSize: 512,
  clipToShape: true,
  softEdge: true,
  depth: 0.45,
  curvature: 0.4,
  dispersion: 0.18,
  strength: 0.15,
  bend: 0.35,
  bendWidth: 0.12,
  frost: 5,
  brightness: 0.15,
  specular: 1.35,
  sheenAngle: 55,
  glow: 0.15,
  glowSpread: 1,
  sheen: 0.75,
  sheenWidth: 2.5,
};

export const PLAY_BUTTON_OPTICS: Partial<GlassOptics> = {
  mapSize: 512,
  clipToShape: true,
  softEdge: true,
  depth: 0.5,
  curvature: 0.42,
  dispersion: 0.2,
  strength: 0.18,
  bend: 0.38,
  bendWidth: 0.14,
  frost: 5.5,
  brightness: 0.22,
  specular: 1.5,
  sheenAngle: 60,
  glow: 0.2,
  glowSpread: 1.1,
  sheen: 0.9,
  sheenWidth: 3,
};

export const POPOVER_OPTICS: Partial<GlassOptics> = {
  mapSize: 512,
  clipToShape: true,
  softEdge: true,
  depth: 0.55,
  curvature: 0.3,
  dispersion: 0.15,
  strength: 0.12,
  bend: 0.4,
  bendWidth: 0.1,
  frost: 6,
  brightness: 0.18,
  specular: 1.15,
  sheenAngle: 50,
  glow: 0.12,
  glowSpread: 1.1,
  sheen: 0.55,
  sheenWidth: 2.5,
};

export const MENU_OPTICS: Partial<GlassOptics> = {
  mapSize: 256,
  clipToShape: true,
  softEdge: true,
  depth: 0.55,
  curvature: 0.26,
  dispersion: 0.16,
  strength: 0.15,
  bend: 0.55,
  bendWidth: 0.08,
  frost: 5.5,
  brightness: 0.16,
  specular: 0.9,
  sheenAngle: 45,
  glow: 0.06,
  glowSpread: 1,
  sheen: 0.45,
  sheenWidth: 1.5,
};

export const TOAST_OPTICS: Partial<GlassOptics> = {
  mapSize: 256,
  clipToShape: true,
  softEdge: true,
  depth: 0.5,
  curvature: 0.3,
  dispersion: 0.18,
  strength: 0.13,
  bend: 0.45,
  bendWidth: 0.1,
  frost: 4.5,
  brightness: 0.16,
  specular: 1.1,
  sheenAngle: 50,
  glow: 0.14,
  glowSpread: 1,
  sheen: 0.65,
  sheenWidth: 2,
};

export interface LiquidGlassSurfaceProps
  extends React.HTMLAttributes<HTMLElement> {
  as?: "button" | "div";
  variant?: LiquidGlassVariant;
  size?: number;
  width?: number | string;
  height?: number | string;
  radius?: number;
  isActive?: boolean;
  optics?: Partial<GlassOptics>;
  filterResolution?: number;
  refract?: React.ReactNode;
  behind?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}

export const LiquidGlassSurface = forwardRef<HTMLElement, LiquidGlassSurfaceProps>(
  (
    {
      as = "div",
      variant = "button",
      size,
      width,
      height,
      radius,
      isActive = false,
      optics,
      filterResolution = 1, // Platform constraint: 1 for macOS WKWebView/Safari
      refract,
      behind,
      disabled,
      type = "button",
      className = "",
      style,
      children,
      onClick,
      ...rest
    },
    ref
  ) => {
    const shouldReduceMotion = Boolean(useReducedMotion());

    const effectiveWidth = size ?? width;
    const effectiveHeight = size ?? height;
    const effectiveRadius =
      radius ?? (typeof size === "number" ? Math.round(size / 2) : 14);

    const baseOptics = useMemo(() => {
      switch (variant) {
        case "play":
          return PLAY_BUTTON_OPTICS;
        case "popover":
          return POPOVER_OPTICS;
        case "menu":
          return MENU_OPTICS;
        case "toast":
          return TOAST_OPTICS;
        case "button":
        default:
          return COMPACT_BUTTON_OPTICS;
      }
    }, [variant]);

    const effectiveOptics: Partial<GlassOptics> = useMemo(() => {
      const combined = { ...baseOptics, ...optics };
      if (shouldReduceMotion) {
        // In reduced motion, eliminate physical refraction displacement and dispersion
        return {
          ...combined,
          strength: 0,
          dispersion: 0,
          bend: 0,
          curvature: 0,
        };
      }
      return combined;
    }, [baseOptics, optics, shouldReduceMotion]);

    const Component = (as === "button" ? "button" : "div") as React.ElementType;

    const buttonProps =
      as === "button"
        ? {
            type,
            disabled,
          }
        : {};

    return (
      <Component
        ref={ref}
        className={`liquid-glass-surface ${variant ? `variant-${variant}` : ""} ${
          isActive ? "is-active" : ""
        } ${disabled ? "is-disabled" : ""} ${className}`}
        style={{
          width: effectiveWidth,
          height: effectiveHeight,
          borderRadius: effectiveRadius,
          ...style,
        }}
        onClick={disabled ? undefined : onClick}
        {...buttonProps}
        {...rest}
      >
        {/* 1. Underlying Liquid Glass Lens Layer */}
        <div
          className="liquid-glass-lens-layer"
          aria-hidden="true"
          style={{ borderRadius: effectiveRadius }}
        >
          <Glass
            style={{
              width: "100%",
              height: "100%",
              borderRadius: effectiveRadius,
              background: "transparent",
            }}
            filterResolution={filterResolution}
            optics={effectiveOptics}
            refract={refract}
            behind={behind}
          />
        </div>

        {/* 2. Crisp, Selectable & Focusable Foreground Content Layer */}
        <div className="liquid-glass-content-layer">{children}</div>
      </Component>
    );
  }
);

LiquidGlassSurface.displayName = "LiquidGlassSurface";
