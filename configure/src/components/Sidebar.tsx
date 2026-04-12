import MultiActionButton from "@/components/MultiActionButton";
import { Home, GalleryVerticalEnd, Puzzle, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { SupportButton } from "@/components/SupportButton";

type Page = "home" | "catalogs" | "integrations" | "others";

const menuItems = [
  { icon: Home, label: "Home", id: "home" as Page },
  { icon: GalleryVerticalEnd, label: "Catalogs", id: "catalogs" as Page },
  { icon: Puzzle, label: "Integrations", id: "integrations" as Page },
  { icon: Settings, label: "Others", id: "others" as Page },
];

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  currentPage: Page;
  setCurrentPage: (page: Page) => void;
}

export function Sidebar({ isOpen, setIsOpen, currentPage, setCurrentPage }: SidebarProps) {
  return (
    <>
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 bg-sidebar transform transition-transform duration-200 ease-in-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
          "md:translate-x-0"
        )}
      >
        <div className="flex flex-col min-h-screen py-6 space-y-10">
          <div className="flex items-center gap-2 mx-6 mt-10">
            <img
              src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
              alt="TMDB Logo"
              className="w-60"
            />
          </div>

          <nav className="flex-1">
            <ul>
              {menuItems.map((item) => (
                <li key={item.label}>
                  <button
                    onClick={() => {
                      setCurrentPage(item.id);
                      setIsOpen(false);
                    }}
                    className={cn(
                      "flex items-center w-full px-6 py-2 mt-4 text-gray-500 hover:bg-gray-700/25 hover:text-gray-100",
                      currentPage === item.id &&
                        "bg-gray-700 text-gray-100"
                    )}
                  >
                    <item.icon className="w-5 h-5 mr-2" />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="p-6 grid place-items-center space-y-3">
            <MultiActionButton />
            <SupportButton className="w-full" />
          </div>
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
