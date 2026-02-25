'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { ShieldCheck, Download } from 'lucide-react';
import toast from 'react-hot-toast';

interface ListMember {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  country: string | null;
  verification_status: string;
  source_type: string | null;
  created_at: string;
}

interface ListDetail {
  id: string;
  name: string;
  created_at: string;
  total_leads: number;
  verified_count: number;
  unverified_count: number;
  members: ListMember[];
  import_status?: string;
  import_progress?: Record<string, unknown>;
}

interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

export default function ListDetailPage() {
  useAuthGuard();
  const params = useParams();
  const router = useRouter();
  const listId = params.id as string;

  const [list, setList] = useState<ListDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add Leads Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [addTab, setAddTab] = useState<'manual' | 'import'>('manual');
  const [manualEmail, setManualEmail] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualCountry, setManualCountry] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  // Import State
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<{imported: number; skipped: number; total: number} | null>(null);

  // Verification State
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [hasZeroBounceKey, setHasZeroBounceKey] = useState<boolean | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [verifyPolling, setVerifyPolling] = useState(false);

  // Export State
  const [exporting, setExporting] = useState(false);

  const getToken = () => localStorage.getItem('liffy_token');

  const fetchList = useCallback(async () => {
    if (!listId) return;

    setLoading(true);
    setError(null);

    try {
      const token = getToken();
      const res = await fetch(`/api/lists/${listId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('List not found');
        }
        throw new Error('Failed to fetch list');
      }

      const data = await res.json();
      setList({
        id: data.id,
        name: data.name || 'Unnamed List',
        created_at: data.created_at,
        total_leads: Number(data.total_leads) || 0,
        verified_count: Number(data.verified_count) || 0,
        unverified_count: Number(data.unverified_count) || 0,
        members: Array.isArray(data.members) ? data.members : [],
        import_status: data.import_status,
        import_progress: data.import_progress
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch list';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [listId]);

  // Check if ZeroBounce key is configured
  const checkZeroBounceKey = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch('/api/settings', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setHasZeroBounceKey(!!data.has_zerobounce_key);
      }
    } catch {
      setHasZeroBounceKey(false);
    }
  }, []);

  // Fetch queue status for this list
  const fetchQueueStatus = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`/api/verification/queue-status?list_id=${listId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data: QueueStatus = await res.json();
        setQueueStatus(data);

        // Stop polling if no pending/processing items remain
        if (data.pending === 0 && data.processing === 0) {
          setVerifyPolling(false);
          // Refresh list to update verification badges
          fetchList();
        }
      }
    } catch {
      // silent fail on status polling
    }
  }, [listId, fetchList]);

  useEffect(() => {
    fetchList();
    checkZeroBounceKey();
  }, [fetchList, checkZeroBounceKey]);

  // Poll queue status when verification is active
  useEffect(() => {
    if (!verifyPolling) return;
    fetchQueueStatus();
    const interval = setInterval(fetchQueueStatus, 5000);
    return () => clearInterval(interval);
  }, [verifyPolling, fetchQueueStatus]);

  const handleVerifyAll = async () => {
    const token = getToken();
    if (!token) return;

    setVerifyLoading(true);
    try {
      const res = await fetch('/api/verification/verify-list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ list_id: listId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to queue verification');

      const queued = data.queued || 0;
      const alreadyVerified = data.already_verified || 0;
      const alreadyInQueue = data.already_in_queue || 0;

      const parts: string[] = [];
      if (alreadyVerified > 0) parts.push(`${alreadyVerified} already verified`);
      if (alreadyInQueue > 0) parts.push(`${alreadyInQueue} already in queue`);
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';

      if (queued > 0) {
        toast.success(`${queued} email${queued !== 1 ? 's' : ''} queued for verification${suffix}`);
        setVerifyPolling(true);
        fetchQueueStatus();
      } else {
        toast.success(`No new emails to verify${suffix}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to queue verification';
      toast.error(msg);
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleRemoveMember = async (prospectId: string) => {
    if (!confirm('Remove this lead from the list?')) return;

    try {
      const token = getToken();
      const res = await fetch(`/api/lists/${listId}/members/${prospectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) throw new Error('Failed to remove member');

      setList(prev => {
        if (!prev) return prev;
        const newMembers = prev.members.filter(m => m.id !== prospectId);
        const newVerified = newMembers.filter(m => m.verification_status === 'valid').length;
        return {
          ...prev,
          members: newMembers,
          total_leads: newMembers.length,
          verified_count: newVerified,
          unverified_count: newMembers.length - newVerified
        };
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to remove member';
      alert(msg);
    }
  };

  const handleAddManual = async () => {
    if (!manualEmail.trim() || !manualEmail.includes('@')) {
      setAddError('Valid email is required');
      return;
    }

    setAddLoading(true);
    setAddError(null);
    setAddSuccess(null);

    try {
      const token = getToken();
      const res = await fetch(`/api/lists/${listId}/add-manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          email: manualEmail.trim(),
          name: manualName.trim() || null,
          company: manualCompany.trim() || null,
          country: manualCountry.trim() || null
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to add prospect');
      }

      setAddSuccess(`Added ${manualEmail.trim()}`);
      setManualEmail('');
      setManualName('');
      setManualCompany('');
      setManualCountry('');

      // Refresh list
      fetchList();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add prospect';
      setAddError(msg);
    } finally {
      setAddLoading(false);
    }
  };

  const handleImportBulk = async () => {
    if (!importText.trim()) {
      setAddError('Please paste email data');
      return;
    }

    setAddLoading(true);
    setAddError(null);
    setAddSuccess(null);
    setImportResult(null);

    try {
      // Parse CSV/text - support multiple formats
      const lines = importText.trim().split('\n').filter(line => line.trim());
      const prospects: {email: string; name?: string; company?: string; country?: string}[] = [];

      for (const line of lines) {
        // Try to parse as CSV (comma or tab separated)
        const parts = line.includes('\t') ? line.split('\t') : line.split(',');
        const email = parts[0]?.trim();

        if (email && email.includes('@')) {
          prospects.push({
            email,
            name: parts[1]?.trim() || undefined,
            company: parts[2]?.trim() || undefined,
            country: parts[3]?.trim() || undefined
          });
        }
      }

      if (prospects.length === 0) {
        throw new Error('No valid emails found. Format: email, name, company, country (one per line)');
      }

      const token = getToken();
      const res = await fetch(`/api/lists/${listId}/import-bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ prospects })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to import');
      }

      setImportResult({
        imported: data.imported,
        skipped: data.skipped,
        total: data.total
      });
      setAddSuccess(`Imported ${data.imported} of ${data.total} prospects`);
      setImportText('');

      // Refresh list
      fetchList();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to import';
      setAddError(msg);
    } finally {
      setAddLoading(false);
    }
  };

  const resetAddModal = () => {
    setShowAddModal(false);
    setAddTab('manual');
    setManualEmail('');
    setManualName('');
    setManualCompany('');
    setManualCountry('');
    setImportText('');
    setAddError(null);
    setAddSuccess(null);
    setImportResult(null);
  };

  const handleExportAll = async (format: 'xlsx' | 'csv' = 'xlsx') => {
    try {
      setExporting(true);
      const response = await fetch(`/api/lists/${listId}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `list-${listId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setExporting(false);
    }
  };

  const getStatusBadgeClass = (status: string): string => {
    switch (status) {
      case 'valid': return 'bg-green-100 text-green-800 hover:bg-green-100';
      case 'invalid': return 'bg-red-100 text-red-800 hover:bg-red-100';
      case 'catchall': return 'bg-amber-100 text-amber-800 hover:bg-amber-100';
      case 'unknown': return 'bg-gray-100 text-gray-800 hover:bg-gray-100';
      case 'pending': return 'bg-blue-100 text-blue-800 hover:bg-blue-100';
      case 'processing': return 'bg-purple-100 text-purple-800 hover:bg-purple-100';
      default: return 'bg-gray-100 text-gray-600 hover:bg-gray-100';
    }
  };

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case 'valid': return 'default';
      case 'invalid': return 'destructive';
      case 'risky':
      case 'catchall':
      case 'unknown': return 'secondary';
      default: return 'outline';
    }
  };

  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return '-';
    }
  };

  // Compute verification breakdown from members
  const verificationBreakdown = list ? (() => {
    const counts: Record<string, number> = {};
    for (const m of list.members) {
      const status = m.verification_status || 'unverified';
      counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
  })() : {};

  if (loading) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center">
              <div className="h-8 w-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-muted-foreground">Loading list...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4">
              <p className="text-red-600">{error}</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => router.push('/lists')}>
                  Back to Lists
                </Button>
                <Button variant="outline" onClick={fetchList}>
                  Retry
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!list) {
    return null;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Button variant="ghost" size="sm" onClick={() => router.push('/lists')}>
              ← Back
            </Button>
          </div>
          <h1 className="text-2xl font-semibold">{list.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Created on {formatDate(list.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    onClick={handleVerifyAll}
                    disabled={verifyLoading || hasZeroBounceKey === false || list.total_leads === 0}
                  >
                    {verifyLoading ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                        Queuing...
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" />
                        Verify All Emails
                      </span>
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              {hasZeroBounceKey === false && (
                <TooltipContent>
                  <p>Configure ZeroBounce API key in Settings first</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="outline"
            onClick={() => handleExportAll('xlsx')}
            disabled={exporting || !list || list.total_leads === 0}
          >
            <Download className="h-4 w-4 mr-1" />
            {exporting ? 'Exporting...' : `Export (${list?.total_leads || 0})`}
          </Button>
          <Button onClick={() => setShowAddModal(true)}>
            + Add Leads
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total Leads</p>
            <p className="text-2xl font-semibold">{formatNumber(list.total_leads)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Verified</p>
            <p className="text-2xl font-semibold text-green-600">{formatNumber(list.verified_count)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Invalid</p>
            <p className="text-2xl font-semibold text-red-600">{formatNumber(verificationBreakdown['invalid'] || 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Unverified</p>
            <p className="text-2xl font-semibold text-gray-500">{formatNumber(list.unverified_count)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Verification Progress (shown when polling) */}
      {(verifyPolling || (queueStatus && (queueStatus.pending > 0 || queueStatus.processing > 0))) && queueStatus && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <span className="h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                Verification in Progress
              </h3>
              <span className="text-xs text-muted-foreground">Auto-refreshing every 5s</span>
            </div>
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
              {queueStatus.completed > 0 && (
                <div
                  className="bg-green-500 h-full transition-all duration-500"
                  style={{ width: `${(queueStatus.completed / queueStatus.total) * 100}%` }}
                />
              )}
              {queueStatus.processing > 0 && (
                <div
                  className="bg-purple-500 h-full transition-all duration-500"
                  style={{ width: `${(queueStatus.processing / queueStatus.total) * 100}%` }}
                />
              )}
              {queueStatus.failed > 0 && (
                <div
                  className="bg-red-500 h-full transition-all duration-500"
                  style={{ width: `${(queueStatus.failed / queueStatus.total) * 100}%` }}
                />
              )}
              {queueStatus.pending > 0 && (
                <div
                  className="bg-blue-200 h-full transition-all duration-500"
                  style={{ width: `${(queueStatus.pending / queueStatus.total) * 100}%` }}
                />
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Completed ({queueStatus.completed})
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> Processing ({queueStatus.processing})
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Failed ({queueStatus.failed})
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-200 inline-block" /> Pending ({queueStatus.pending})
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {list.members.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <h3 className="font-medium text-gray-900 mb-1">No leads in this list</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Add leads manually or import from CSV.
              </p>
              <Button onClick={() => setShowAddModal(true)}>
                + Add Leads
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.members.map(member => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">{member.email}</TableCell>
                  <TableCell>{member.name || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{member.company || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{member.country || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <Badge className={getStatusBadgeClass(member.verification_status || 'unverified')}>
                      {member.verification_status || 'unverified'}
                    </Badge>
                  </TableCell>
                  <TableCell>{member.source_type || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleRemoveMember(member.id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Add Leads Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={resetAddModal} />
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-xl p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold mb-1">Add Leads to List</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Add leads manually or import from CSV/Excel.
            </p>

            {/* Tabs */}
            <div className="flex gap-2 mb-4 border-b">
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  addTab === 'manual'
                    ? 'border-orange-500 text-orange-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                onClick={() => setAddTab('manual')}
              >
                Manual Entry
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  addTab === 'import'
                    ? 'border-orange-500 text-orange-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                onClick={() => setAddTab('import')}
              >
                Bulk Import
              </button>
            </div>

            {addError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-600">{addError}</p>
              </div>
            )}

            {addSuccess && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-600">{addSuccess}</p>
              </div>
            )}

            {addTab === 'manual' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={manualEmail}
                    onChange={(e) => setManualEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <Input
                    placeholder="John Doe"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
                  <Input
                    placeholder="Acme Corp"
                    value={manualCompany}
                    onChange={(e) => setManualCompany(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                  <Input
                    placeholder="Germany"
                    value={manualCountry}
                    onChange={(e) => setManualCountry(e.target.value)}
                  />
                </div>
              </div>
            )}

            {addTab === 'import' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Paste CSV Data
                  </label>
                  <textarea
                    className="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
                    placeholder="email@example.com, John Doe, Acme Corp, Germany
another@email.com, Jane Smith, Tech Inc, USA
..."
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Format: email, name, company, country (one per line). Only email is required.
                  </p>
                </div>

                {importResult && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-sm text-blue-800">
                      <strong>{importResult.imported}</strong> imported, <strong>{importResult.skipped}</strong> skipped (of {importResult.total} total)
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
              <Button variant="ghost" onClick={resetAddModal} disabled={addLoading}>
                Cancel
              </Button>
              <Button
                onClick={addTab === 'manual' ? handleAddManual : handleImportBulk}
                disabled={addLoading}
              >
                {addLoading ? 'Adding...' : addTab === 'manual' ? 'Add Lead' : 'Import All'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
