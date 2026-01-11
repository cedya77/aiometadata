import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { toast } from "sonner";
import {
  Search,
  MoreHorizontal,
  Eye,
  Key,
  Trash2,
  Download,
  RefreshCw,
  Users,
  Calendar,
  Activity,
  Settings,
  AlertTriangle,
} from "lucide-react";

interface User {
  uuid: string;
  created_at: string;
  last_updated: string;
  last_activity?: string;
  total_requests: number;
  has_api_keys: boolean;
  config_status: string;
  is_active: boolean;
}

interface UserDetails {
  uuid: string;
  created_at: string;
  last_updated: string;
  last_activity?: string;
  total_requests: number;
  api_keys: {
    tmdb?: boolean;
    tvdb?: boolean;
    imdb?: boolean;
    kitsu?: boolean;
  };
  streaming_services: string[];
  catalogs_count: number;
  language: string;
  region: string;
}

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminKey?: string;
}

export function UserManagementModal({ isOpen, onClose, adminKey }: UserManagementModalProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [showUserDetails, setShowUserDetails] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
    }
  }, [isOpen]);

  useEffect(() => {
    const filtered = users.filter(user =>
      user.uuid.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.created_at.toLowerCase().includes(searchTerm.toLowerCase())
    );
    setFilteredUsers(filtered);
  }, [users, searchTerm]);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/admin/users', {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        setUsers(data.users || []);
      } else {
        toast.error('Failed to fetch users');
      }
    } catch (error) {
      toast.error('Error fetching users');
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchUserDetails = async (uuid: string) => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`/api/admin/users/${uuid}`, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedUser(data.user);
        setShowUserDetails(true);
      } else {
        toast.error('Failed to fetch user details');
      }
    } catch (error) {
      toast.error('Error fetching user details');
      console.error('Error fetching user details:', error);
    }
  };

  const resetUserPassword = async (uuid: string) => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`/api/admin/users/${uuid}/reset-password`, {
        method: 'POST',
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(`Password reset for user ${uuid.substring(0, 8)}...`);
        toast.info(`New password: ${data.newPassword}`);
      } else {
        toast.error('Failed to reset password');
      }
    } catch (error) {
      toast.error('Error resetting password');
      console.error('Error resetting password:', error);
    }
  };

  const deleteUser = async (uuid: string) => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`/api/admin/users/${uuid}`, {
        method: 'DELETE',
        headers,
      });

      if (response.ok) {
        toast.success('User deleted successfully');
        fetchUsers(); // Refresh the list
      } else {
        toast.error('Failed to delete user');
      }
    } catch (error) {
      toast.error('Error deleting user');
      console.error('Error deleting user:', error);
    } finally {
      setShowDeleteDialog(false);
      setUserToDelete(null);
    }
  };

  const exportUserData = async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/admin/users/export', {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `users-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        toast.success('User data exported successfully');
      } else {
        toast.error('Failed to export user data');
      }
    } catch (error) {
      toast.error('Error exporting user data');
      console.error('Error exporting user data:', error);
    }
  };

  const bulkDeleteInactiveUsers = async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/admin/users/bulk-delete-inactive', {
        method: 'POST',
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(`${data.deletedCount} inactive users deleted`);
        fetchUsers(); // Refresh the list
      } else {
        toast.error('Failed to delete inactive users');
      }
    } catch (error) {
      toast.error('Error deleting inactive users');
      console.error('Error deleting inactive users:', error);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString() + ' ' + new Date(dateString).toLocaleTimeString();
  };

  const formatRelativeTime = (dateString?: string) => {
    if (!dateString) return 'Never';
    const now = new Date();
    const date = new Date(dateString);
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
    
    if (diffInHours < 1) return 'Less than 1 hour ago';
    if (diffInHours < 24) return `${diffInHours} hours ago`;
    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} days ago`;
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-6xl max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              User Management
            </DialogTitle>
            <DialogDescription>
              Manage users, view configurations, and perform administrative actions
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Search and Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search users by UUID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={fetchUsers} disabled={loading}>
                  <RefreshCw className={`h-4 w-4 sm:mr-2 ${loading ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
                <Button variant="outline" size="sm" onClick={exportUserData}>
                  <Download className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Export All</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <MoreHorizontal className="h-4 w-4 sm:mr-2" />
                      <span className="hidden sm:inline">Bulk Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={bulkDeleteInactiveUsers}>
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      Delete Inactive Users (30+ days)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Desktop: Users Table */}
            <div className="hidden sm:block border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>UUID</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last Updated</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>API Keys</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
                        Loading users...
                      </TableCell>
                    </TableRow>
                  ) : filteredUsers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        No users found
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredUsers.map((user) => (
                      <TableRow key={user.uuid}>
                        <TableCell className="font-mono text-sm">
                          {user.uuid.substring(0, 8)}...
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Calendar className="h-3 w-3 text-muted-foreground" />
                            {formatDate(user.created_at)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Activity className="h-3 w-3 text-muted-foreground" />
                            {formatRelativeTime(user.last_updated)}
                          </div>
                        </TableCell>
                        <TableCell>{user.total_requests.toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge variant={user.is_active ? "default" : "secondary"}>
                            {user.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={user.has_api_keys ? "default" : "destructive"}>
                            {user.has_api_keys ? "Configured" : "Missing"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => fetchUserDetails(user.uuid)}>
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => resetUserPassword(user.uuid)}>
                                <Key className="h-4 w-4 mr-2" />
                                Reset Password
                              </DropdownMenuItem>
                              <DropdownMenuItem 
                                onClick={() => {
                                  setUserToDelete(user);
                                  setShowDeleteDialog(true);
                                }}
                                className="text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete User
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: Users Cards */}
            <div className="sm:hidden space-y-3 max-h-[50vh] overflow-y-auto">
              {loading ? (
                <div className="text-center py-8">
                  <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
                  Loading users...
                </div>
              ) : filteredUsers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No users found
                </div>
              ) : (
                filteredUsers.map((user) => (
                  <div key={user.uuid} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm">{user.uuid.substring(0, 8)}...</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => fetchUserDetails(user.uuid)}>
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => resetUserPassword(user.uuid)}>
                            <Key className="h-4 w-4 mr-2" />
                            Reset Password
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => {
                              setUserToDelete(user);
                              setShowDeleteDialog(true);
                            }}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-muted-foreground">Created</span>
                      <span>{formatDate(user.created_at)}</span>
                    </div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-muted-foreground">Last Updated</span>
                      <span>{formatRelativeTime(user.last_updated)}</span>
                    </div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Requests</span>
                      <span>{user.total_requests.toLocaleString()}</span>
                    </div>
                    <div className="flex gap-2">
                      <Badge variant={user.is_active ? "default" : "secondary"}>
                        {user.is_active ? "Active" : "Inactive"}
                      </Badge>
                      <Badge variant={user.has_api_keys ? "default" : "destructive"}>
                        {user.has_api_keys ? "Configured" : "Missing"}
                      </Badge>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="text-sm text-muted-foreground">
              Showing {filteredUsers.length} of {users.length} users
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* User Details Modal */}
      <Dialog open={showUserDetails} onOpenChange={setShowUserDetails}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              User Details
            </DialogTitle>
            <DialogDescription>
              Detailed information about this user's configuration
            </DialogDescription>
          </DialogHeader>

          {selectedUser && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">UUID</label>
                  <p className="text-sm text-muted-foreground font-mono break-all">{selectedUser.uuid}</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Created</label>
                  <p className="text-sm text-muted-foreground">{formatDate(selectedUser.created_at)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Last Updated</label>
                  <p className="text-sm text-muted-foreground">{formatRelativeTime(selectedUser.last_updated)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Total Requests</label>
                  <p className="text-sm text-muted-foreground">{selectedUser.total_requests.toLocaleString()}</p>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">API Keys</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  <Badge variant={selectedUser.api_keys.tmdb ? "default" : "secondary"}>TMDB</Badge>
                  <Badge variant={selectedUser.api_keys.tvdb ? "default" : "secondary"}>TVDB</Badge>
                  <Badge variant={selectedUser.api_keys.imdb ? "default" : "secondary"}>IMDB</Badge>
                  <Badge variant={selectedUser.api_keys.kitsu ? "default" : "secondary"}>Kitsu</Badge>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Language</label>
                  <p className="text-sm text-muted-foreground">{selectedUser.language}</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Region</label>
                  <p className="text-sm text-muted-foreground">{selectedUser.region}</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Streaming Services</label>
                  <p className="text-sm text-muted-foreground">{selectedUser.streaming_services.length} configured</p>
                </div>
                <div>
                  <label className="text-sm font-medium">Catalogs</label>
                  <p className="text-sm text-muted-foreground">{selectedUser.catalogs_count} catalogs</p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete user <span className="font-mono">{userToDelete?.uuid.substring(0, 8)}...</span>?
              This action cannot be undone and will permanently remove all user data and configuration.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => userToDelete && deleteUser(userToDelete.uuid)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete User
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
