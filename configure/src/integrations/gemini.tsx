import { useState, useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";

export default function Gemini() {
  const { geminikey, setGeminiKey } = useConfig();
  const [tempKey, setTempKey] = useState(geminikey);
  const [error, setError] = useState("");
  const [isValid, setIsValid] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    setTempKey(geminikey);
    if (geminikey) {
      validateGeminiKey(geminikey);
    }
  }, [geminikey]);

  const validateGeminiKey = async (key: string) => {
    if (!key) {
      setIsValid(false);
      setError("");
      return false;
    }

    setIsChecking(true);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${key}`); 
      const data = await response.json();

      if (!(data || {})) {
        setError("Gemini Key is invalid, please try again");
        setIsValid(false);
        return false;
      }
      setError("");
      setIsValid(true);
      return true;
    } catch (e) {
      console.error(e);
      setError("Error validating Gemini key");
      setIsValid(false);
      return false;
    } finally {
      setIsChecking(false);
    }
  };

  const handleSave = () => {
    if (isValid) {
      setGeminiKey(tempKey);
    }
  };

  const handleCancel = () => {
    setTempKey(geminikey);
    setError("");
    setIsValid(!!geminikey);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col space-y-4">
        <div className="space-y-2">
          <Label htmlFor="geminikey">
            Gemini API Key (get it from{" "}
            <a
              href="https://ai.google.dev/gemini-api/docs/api-key"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Gemini
            </a>
            )
          </Label>
          <Input
            id="geminikey"
            value={tempKey}
            onChange={(e) => {
              setTempKey(e.target.value);
              setIsValid(false);
              setError("");
            }}
            placeholder="Enter your Gemini API key"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex justify-end space-x-2">
        <DialogClose asChild>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        </DialogClose>
        {isValid ? (
          <DialogClose asChild>
            <Button onClick={handleSave}>
              Save Changes
            </Button>
          </DialogClose>
        ) : (
          <Button
            onClick={() => validateGeminiKey(tempKey)}
            disabled={!tempKey || isChecking}
          >
            {isChecking ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Checking
              </>
            ) : (
              "Check Key"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
