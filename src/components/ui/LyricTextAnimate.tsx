import React, { useMemo } from "react";
import { motion, type Variants } from "motion/react";

export interface LyricTextAnimateProps {
  text: string;
  lineId: number | string;
  className?: string;
  reduceMotion?: boolean;
}

/**
 * Reusable Magic UI-inspired Text Animate component for line-synced lyrics.
 * Delivers a subtle word-by-word staggered entrance when a line becomes active.
 * Only triggers when active line ID changes; respects prefers-reduced-motion.
 */
export const LyricTextAnimate: React.FC<LyricTextAnimateProps> = ({
  text,
  lineId,
  className = "fullscreen-lyric-text",
  reduceMotion = false,
}) => {
  const words = useMemo(() => {
    if (!text) return [];
    return text.split(/\s+/).filter(Boolean);
  }, [text]);

  if (reduceMotion || words.length <= 1) {
    return <span className={className}>{text}</span>;
  }

  const containerVariants: Variants = {
    hidden: { opacity: 0.75 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.025, // 25ms subtle stagger between words
        delayChildren: 0.015,
      },
    },
    exit: {
      opacity: 0.8,
      transition: { duration: 0.18 },
    },
  };

  const wordVariants: Variants = {
    hidden: {
      opacity: 0.25,
      y: 3,
      filter: "blur(3px)",
    },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: {
        type: "spring",
        stiffness: 300,
        damping: 28,
        mass: 0.7,
      },
    },
    exit: {
      opacity: 0.8,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: 0.15 },
    },
  };

  return (
    <motion.span
      key={`lyric-text-${lineId}`}
      className={className}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{ display: "inline" }}
    >
      {words.map((word, idx) => (
        <React.Fragment key={`${lineId}-w-${idx}`}>
          <motion.span
            variants={wordVariants}
            className="fullscreen-animate-word"
            style={{
              display: "inline-block",
              background: "transparent",
              willChange: "transform, opacity, filter",
            }}
          >
            {word}
          </motion.span>
          {idx < words.length - 1 ? " " : null}
        </React.Fragment>
      ))}
    </motion.span>
  );
};
