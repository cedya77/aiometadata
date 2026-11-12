import { User } from 'lucide-react';
import { cn } from '@/lib/utils';

const IMAGE_URL = /^https?:\/\//i;

export function Face({ name, avatar, className }: { name: string; avatar?: string; className?: string }) {
  const ring = 'h-8 w-8 rounded-full border-2 border-background';
  if (avatar && IMAGE_URL.test(avatar)) return <img src={avatar} alt="" className={cn(ring, 'bg-muted object-cover', className)} />;
  return (
    <div className={cn(ring, 'flex items-center justify-center bg-muted text-xs font-semibold text-muted-foreground', className)}>
      {name.trim()[0]?.toUpperCase() ?? <User className="h-1/2 w-1/2" />}
    </div>
  );
}
