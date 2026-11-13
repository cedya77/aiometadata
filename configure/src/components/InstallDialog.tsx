// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Link, Copy, Globe } from "lucide-react";
import { useEffect, useState } from "react";

interface InstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  manifestUrl: string;
}

export function InstallDialog({ isOpen, onClose, manifestUrl }: InstallDialogProps) {
  const [stremioProtocolUrl, setStremioProtocolUrl] = useState('');
  const [stremioWebUrl, setStremioWebUrl] = useState('');

  useEffect(() => {
    if (manifestUrl) {
      const protocolLessManifestUrl = manifestUrl.replace(/^https?:\/\//, '');
      const encodedManifestUrl = encodeURIComponent(manifestUrl);
      setStremioProtocolUrl(`stremio://${protocolLessManifestUrl}`);
      setStremioWebUrl(`https://web.stremio.com/#/addons?addon=${encodedManifestUrl}`);
    }
  }, [manifestUrl]);

  if (!isOpen) return null;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(manifestUrl);
    toast.success("Manifest URL copied to clipboard!");
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install Addon</DialogTitle>
          <DialogDescription>
            Choose your preferred method to install the addon configuration.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          
          <a href={stremioProtocolUrl}>
            <Button className="w-full justify-start space-x-2">
              <Link className="h-4 w-4" />
              <span>Open in Stremio Desktop App</span>
            </Button>
          </a>
          
          <a href={stremioWebUrl} target="_blank" rel="noopener noreferrer">
            <Button className="w-full justify-start space-x-2" variant="secondary">
              <Globe className="h-4 w-4" />
              <span>Open in Stremio Web</span>
            </Button>
          </a>

          <div className="mt-4 space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Or copy the manifest link manually:</label>
            <div className="flex w-full items-center space-x-2">
              <Input 
                value={manifestUrl}
                readOnly 
              />
              <Button type="button" size="icon" onClick={copyToClipboard} variant="outline">
                <Copy className="h-4 w-4" />
                <span className="sr-only">Copy URL</span>
              </Button>
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}
