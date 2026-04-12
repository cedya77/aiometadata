import { cn } from "@/lib/utils";

interface SupportButtonProps {
  className?: string;
  label?: string;
}

export function SupportButton({ className, label = "Support me" }: SupportButtonProps) {
  return (
    <a
      href="https://buymeacoffee.com/cedya"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-[#ffdd00] px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90",
        className
      )}
    >
      {label}
    </a>
  );
}
