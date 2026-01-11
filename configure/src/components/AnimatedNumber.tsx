import { useEffect, useRef, useState } from 'react';

interface AnimatedNumberProps {
  value: number;
  /** Duration of animation in ms (default: 500) */
  duration?: number;
  /** Format function for display (default: toLocaleString) */
  format?: (value: number) => string;
  /** CSS class for the number */
  className?: string;
  /** Suffix to append (e.g., '%', 'ms') */
  suffix?: string;
  /** Prefix to prepend (e.g., '$') */
  prefix?: string;
  /** Decimal places to show */
  decimals?: number;
}

/**
 * Animated number component that smoothly transitions between values
 * Uses CSS opacity fade combined with value interpolation
 */
export function AnimatedNumber({
  value,
  duration = 500,
  format,
  className = '',
  suffix = '',
  prefix = '',
  decimals,
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevValueRef = useRef(value);
  const animationRef = useRef<number>();
  const startTimeRef = useRef<number>();
  const startValueRef = useRef<number>(value);

  useEffect(() => {
    // Skip if value hasn't changed
    if (prevValueRef.current === value) return;

    const startValue = prevValueRef.current;
    const endValue = value;
    startValueRef.current = startValue;
    prevValueRef.current = value;

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    setIsAnimating(true);
    startTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - (startTimeRef.current || currentTime);
      const progress = Math.min(elapsed / duration, 1);
      
      // Ease out cubic for smooth deceleration
      const easeOut = 1 - Math.pow(1 - progress, 3);
      
      const currentValue = startValue + (endValue - startValue) * easeOut;
      setDisplayValue(currentValue);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(endValue);
        setIsAnimating(false);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [value, duration]);

  // Format the display value
  const formatValue = (val: number): string => {
    if (format) return format(val);
    
    if (decimals !== undefined) {
      return val.toFixed(decimals);
    }
    
    // For whole numbers, round during animation
    if (Number.isInteger(value)) {
      return Math.round(val).toLocaleString();
    }
    
    return val.toLocaleString(undefined, { 
      minimumFractionDigits: 0,
      maximumFractionDigits: 1 
    });
  };

  return (
    <span 
      className={`transition-opacity duration-150 ${isAnimating ? 'opacity-80' : 'opacity-100'} ${className}`}
    >
      {prefix}{formatValue(displayValue)}{suffix}
    </span>
  );
}

/**
 * Simpler version that just fades between values without counting
 * Good for non-numeric values or when counting looks odd
 */
export function FadeValue({ 
  value, 
  className = '' 
}: { 
  value: React.ReactNode; 
  className?: string;
}) {
  const [displayValue, setDisplayValue] = useState(value);
  const [isFading, setIsFading] = useState(false);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (prevValueRef.current === value) return;
    
    setIsFading(true);
    
    // Fade out, change value, fade in
    const timeout = setTimeout(() => {
      setDisplayValue(value);
      prevValueRef.current = value;
      setIsFading(false);
    }, 150);

    return () => clearTimeout(timeout);
  }, [value]);

  return (
    <span 
      className={`transition-opacity duration-150 ${isFading ? 'opacity-0' : 'opacity-100'} ${className}`}
    >
      {displayValue}
    </span>
  );
}
