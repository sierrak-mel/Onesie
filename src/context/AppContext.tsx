import React, { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth, PENDING_INVITE_KEY } from '@/context/AuthContext';
import { toast } from '@/hooks/use-toast';
import type { Side, DiaperType, ColorNote, SleepType, ContentType, UnitPreference } from '@/types';
import type { FeedingSession, DiaperChange, SleepSession, PumpingSession, BottleFeed, BabyProfile } from '@/types';

interface Caregiver {
  id: string;
  family_id: string;
  user_id: string;
  display_name: string;
  role: 'owner' | 'member';
  invite_email: string | null;
}

interface AppState {
  profile: BabyProfile | null;
  setProfile: (p: BabyProfile) => void;
  feedings: FeedingSession[];
  activeFeeding: FeedingSession | null;
  startFeeding: (side: Side) => void;
  stopFeeding: (notes?: string) => void;
  deleteFeeding: (id: string) => void;
  addPastFeeding: (f: Omit<FeedingSession, 'id'>) => void;
  updateFeeding: (id: string, updates: Partial<FeedingSession>) => void;
  diapers: DiaperChange[];
  logDiaper: (type: DiaperType, colorNote?: ColorNote | null, notes?: string) => void;
  deleteDiaper: (id: string) => void;
  addPastDiaper: (d: Omit<DiaperChange, 'id'>) => void;
  updateDiaper: (id: string, updates: Partial<DiaperChange>) => void;
  sleeps: SleepSession[];
  activeSleep: SleepSession | null;
  startSleep: () => void;
  stopSleep: (notes?: string, sleepType?: SleepType) => void;
  deleteSleep: (id: string) => void;
  addPastSleep: (s: Omit<SleepSession, 'id'>) => void;
  updateSleep: (id: string, updates: Partial<SleepSession>) => void;
  // Pumping
  pumpings: PumpingSession[];
  activePumping: PumpingSession | null;
  startPumping: (side: Side) => void;
  stopPumping: (volumeOz?: number | null, notes?: string) => void;
  deletePumping: (id: string) => void;
  addPastPumping: (p: Omit<PumpingSession, 'id'>) => void;
  updatePumping: (id: string, updates: Partial<PumpingSession>) => void;
  // Bottle
  bottleFeeds: BottleFeed[];
  logBottleFeed: (amountOz: number, contentType: ContentType, notes?: string, timestamp?: string) => void;
  deleteBottleFeed: (id: string) => void;
  addPastBottleFeed: (b: Omit<BottleFeed, 'id'>) => void;
  updateBottleFeed: (id: string, updates: Partial<BottleFeed>) => void;
  caregiver: Caregiver | null;
  caregivers: Caregiver[];
  removeCaregiver: (id: string) => void;
  babyProfileId: string | null;
  familyId: string | null;
  loading: boolean;
  // History window: only the last HISTORY_WINDOW_DAYS are loaded up front.
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  loadAllHistory: () => void;
}

// How much tracker history to load when the app opens. Analytics looks back
// at most 30 days, so 31 covers it; History can pull the rest on demand.
// Loading everything on every open was one source of database reads that grow
// with every entry logged.
const HISTORY_WINDOW_DAYS = 31;

// A pending caregiver invite can arrive two ways: stashed in localStorage at
// signup (same device), or in the URL after confirming email (possibly a
// different device — emailRedirectTo carries `?invite=`).
function getPendingInvite(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('invite');
    if (fromUrl) return fromUrl;
  } catch { /* ignore */ }
  try {
    return localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

function clearPendingInvite() {
  try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ignore */ }
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite')) {
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  } catch { /* ignore */ }
}

/**
 * Show a toast when a database write fails. Returns true if there was an error,
 * so callers can bail out *before* changing local state. Previously failures
 * were ignored and the UI showed changes that were never saved.
 */
function writeFailed(action: string, error: { message: string } | null | undefined): boolean {
  if (!error) return false;
  console.error(`[onesie] could not ${action}:`, error.message);
  toast({
    variant: 'destructive',
    title: `Couldn't ${action}`,
    description: 'Nothing was changed. Check your connection and try again.',
  });
  return true;
}

// ── Row → app object mappers (one place instead of ~15 copies) ──
/* eslint-disable @typescript-eslint/no-explicit-any -- generated DB types are stale; see plan tech-debt #4 */
const toFeeding = (f: any): FeedingSession => ({
  id: f.id, startTime: f.start_time, endTime: f.end_time, durationSeconds: f.duration_seconds,
  side: f.side as Side, notes: f.notes || '',
});
const toDiaper = (d: any): DiaperChange => ({
  id: d.id, timestamp: d.timestamp, type: d.type as DiaperType,
  colorNote: d.color_note as ColorNote | null, notes: d.notes || '',
});
const toSleep = (s: any): SleepSession => ({
  id: s.id, startTime: s.start_time, endTime: s.end_time, durationSeconds: s.duration_seconds,
  sleepType: s.sleep_type as SleepType, notes: s.notes || '',
});
const toPumping = (p: any): PumpingSession => ({
  id: p.id, startTime: p.start_time, endTime: p.end_time, durationSeconds: p.duration_seconds,
  side: p.side as Side, volumeOz: p.volume_oz, notes: p.notes || '',
});
const toBottle = (b: any): BottleFeed => ({
  id: b.id, timestamp: b.timestamp, amountOz: Number(b.amount_oz),
  contentType: b.content_type as ContentType, notes: b.notes || '',
});
// Untyped table handle for tables missing from the generated types.
const table = (name: string) => supabase.from(name as any) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const byStartDesc = <T extends { startTime: string }>(a: T, b: T) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
const byTimestampDesc = <T extends { timestamp: string }>(a: T, b: T) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

/** Merge newly fetched rows into existing ones, de-duplicated by id. */
function mergeById<T extends { id: string }>(existing: T[], incoming: T[], sort: (a: T, b: T) => number): T[] {
  const seen = new Set(existing.map(x => x.id));
  return [...existing, ...incoming.filter(x => !seen.has(x.id))].sort(sort);
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [loading, setLoading] = useState(true);
  const [caregiver, setCaregiver] = useState<Caregiver | null>(null);
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [babyProfile, setBabyProfile] = useState<{ id: string; name: string; date_of_birth: string | null; default_start_side: Side; family_id: string; unit_preference: UnitPreference; switch_nursing_enabled: boolean } | null>(null);
  const [feedings, setFeedings] = useState<FeedingSession[]>([]);
  const [diapers, setDiapers] = useState<DiaperChange[]>([]);
  const [sleeps, setSleeps] = useState<SleepSession[]>([]);
  const [pumpings, setPumpings] = useState<PumpingSession[]>([]);
  const [bottleFeeds, setBottleFeeds] = useState<BottleFeed[]>([]);
  // ISO timestamp: tracker rows from before this have not been loaded yet.
  const [historyCutoff, setHistoryCutoff] = useState<string | null>(null);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);

  const babyProfileId = babyProfile?.id || null;
  const familyId = caregiver?.family_id || null;

  const profile: BabyProfile | null = babyProfile ? {
    name: babyProfile.name,
    dateOfBirth: babyProfile.date_of_birth || '',
    defaultStartSide: babyProfile.default_start_side,
    unitPreference: babyProfile.unit_preference || 'oz',
    switchNursingEnabled: babyProfile.switch_nursing_enabled || false,
  } : null;

  // Depend on the user *id*, not the user object. Supabase hands out a new user
  // object on every token refresh (~hourly) and on some tab refocuses, which
  // used to re-download all tracker data each time.
  useEffect(() => {
    if (!userId) {
      setCaregiver(null); setCaregivers([]); setBabyProfile(null);
      setFeedings([]); setDiapers([]); setSleeps([]); setPumpings([]); setBottleFeeds([]);
      setHistoryCutoff(null);
      setLoading(false); return;
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on userId only
  }, [userId]);

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    const { data: cgRows } = await supabase.from('caregivers').select('*').eq('user_id', user.id).limit(1);
    let cg = cgRows?.[0] || null;
    const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'Caregiver';

    // If the user arrived via a caregiver invite link, claim it *before* falling
    // back to creating a brand-new family — otherwise they'd be forked off into
    // their own family instead of joining the inviter's.
    if (!cg) {
      const pendingInvite = getPendingInvite();
      if (pendingInvite) {
        await supabase.rpc('claim_invite', {
          _invite_code: pendingInvite,
          _user_id: user.id,
          _display_name: displayName,
        });
        clearPendingInvite();
        // On success we now have a caregiver row in the inviter's family. (If the
        // code was expired/invalid we fall through to creating their own family.)
        const { data: claimedCg } = await supabase.from('caregivers').select('*').eq('user_id', user.id).maybeSingle();
        cg = claimedCg;
      }
    }

    if (!cg) {
      const { error: rpcError } = await supabase.rpc('create_user_family', {
        p_display_name: displayName,
        p_baby_name: 'Baby',
      });
      if (!rpcError) {
        const { data: newCg } = await supabase.from('caregivers').select('*').eq('user_id', user.id).maybeSingle();
        cg = newCg;
      }
      if (!cg) { setLoading(false); return; }
    }
    setCaregiver(cg as Caregiver);
    const { data: allCgs } = await supabase.from('caregivers').select('*').eq('family_id', cg.family_id);
    setCaregivers((allCgs || []) as Caregiver[]);
    const { data: bp } = await supabase.from('baby_profiles').select('*').eq('family_id', cg.family_id).maybeSingle();
    if (bp) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stale generated types
      const extra = bp as any;
      setBabyProfile({ id: bp.id, name: bp.name, date_of_birth: bp.date_of_birth, default_start_side: bp.default_start_side as Side, family_id: bp.family_id, unit_preference: extra.unit_preference || 'oz', switch_nursing_enabled: extra.switch_nursing_enabled || false });
      await loadRecentTrackerData(bp.id);
    }
    setLoading(false);
  };

  /**
   * Load the last HISTORY_WINDOW_DAYS of tracker data, plus any session that is
   * still running (no end_time) however old, so the active timers never vanish.
   */
  const loadRecentTrackerData = async (bpId: string) => {
    const cutoff = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000).toISOString();
    const recentOrActive = `start_time.gte."${cutoff}",end_time.is.null`;
    const [feedRes, diapRes, sleepRes, pumpRes, bottleRes] = await Promise.all([
      table('feeding_sessions').select('*').eq('baby_profile_id', bpId).or(recentOrActive).order('start_time', { ascending: false }),
      table('diaper_changes').select('*').eq('baby_profile_id', bpId).gte('timestamp', cutoff).order('timestamp', { ascending: false }),
      table('sleep_sessions').select('*').eq('baby_profile_id', bpId).or(recentOrActive).order('start_time', { ascending: false }),
      table('pumping_sessions').select('*').eq('baby_profile_id', bpId).or(recentOrActive).order('start_time', { ascending: false }),
      table('bottle_feeds').select('*').eq('baby_profile_id', bpId).gte('timestamp', cutoff).order('timestamp', { ascending: false }),
    ]);
    const firstError = [feedRes, diapRes, sleepRes, pumpRes, bottleRes].find(r => r.error)?.error;
    if (firstError) {
      console.error('[onesie] could not load history:', firstError.message);
      toast({ variant: 'destructive', title: "Couldn't load your history", description: 'Reopen the app to try again.' });
    }

    setFeedings((feedRes.data || []).map(toFeeding));
    setDiapers((diapRes.data || []).map(toDiaper));
    setSleeps((sleepRes.data || []).map(toSleep));
    setPumpings((pumpRes.data || []).map(toPumping));
    setBottleFeeds((bottleRes.data || []).map(toBottle));
    setHistoryCutoff(cutoff);
  };

  /** Load everything older than the initial window (History → "Show older entries"). */
  const loadAllHistory = useCallback(async () => {
    if (!babyProfileId || !historyCutoff || loadingOlderHistory) return;
    setLoadingOlderHistory(true);
    const [feedRes, diapRes, sleepRes, pumpRes, bottleRes] = await Promise.all([
      table('feeding_sessions').select('*').eq('baby_profile_id', babyProfileId).lt('start_time', historyCutoff),
      table('diaper_changes').select('*').eq('baby_profile_id', babyProfileId).lt('timestamp', historyCutoff),
      table('sleep_sessions').select('*').eq('baby_profile_id', babyProfileId).lt('start_time', historyCutoff),
      table('pumping_sessions').select('*').eq('baby_profile_id', babyProfileId).lt('start_time', historyCutoff),
      table('bottle_feeds').select('*').eq('baby_profile_id', babyProfileId).lt('timestamp', historyCutoff),
    ]);
    setLoadingOlderHistory(false);
    const firstError = [feedRes, diapRes, sleepRes, pumpRes, bottleRes].find(r => r.error)?.error;
    if (writeFailed('load older entries', firstError)) return;

    setFeedings(prev => mergeById(prev, (feedRes.data || []).map(toFeeding), byStartDesc));
    setDiapers(prev => mergeById(prev, (diapRes.data || []).map(toDiaper), byTimestampDesc));
    setSleeps(prev => mergeById(prev, (sleepRes.data || []).map(toSleep), byStartDesc));
    setPumpings(prev => mergeById(prev, (pumpRes.data || []).map(toPumping), byStartDesc));
    setBottleFeeds(prev => mergeById(prev, (bottleRes.data || []).map(toBottle), byTimestampDesc));
    setHistoryCutoff(null); // everything is loaded now
  }, [babyProfileId, historyCutoff, loadingOlderHistory]);

  /**
   * Remove a caregiver from the family (owner only — enforced by RLS).
   * RLS doesn't raise an error when it blocks a delete; it just deletes 0 rows.
   * So ask for the deleted row back and treat "nothing deleted" as a failure.
   */
  const removeCaregiver = useCallback(async (id: string) => {
    const { data, error } = await supabase.from('caregivers').delete().eq('id', id).select('id');
    if (writeFailed('remove the caregiver', error ?? (data && data.length === 0 ? { message: 'not permitted (0 rows deleted)' } : null))) return;
    setCaregivers(prev => prev.filter(c => c.id !== id));
  }, []);

  const activeFeeding = feedings.find(f => !f.endTime) || null;
  const activeSleep = sleeps.find(s => !s.endTime) || null;
  const activePumping = pumpings.find(p => !p.endTime) || null;

  const setProfileFn = useCallback(async (p: BabyProfile) => {
    if (!babyProfileId) return;
    const { error } = await table('baby_profiles').update({
      name: p.name, date_of_birth: p.dateOfBirth || null,
      default_start_side: p.defaultStartSide,
      unit_preference: p.unitPreference,
      switch_nursing_enabled: p.switchNursingEnabled,
    }).eq('id', babyProfileId);
    if (writeFailed('save the profile', error)) return;
    setBabyProfile(prev => prev ? { ...prev, name: p.name, date_of_birth: p.dateOfBirth, default_start_side: p.defaultStartSide, unit_preference: p.unitPreference, switch_nursing_enabled: p.switchNursingEnabled } : prev);
  }, [babyProfileId]);

  // ── Feeding CRUD ──
  const startFeeding = useCallback(async (side: Side) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('feeding_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: new Date().toISOString(), side,
    }).select().single();
    if (writeFailed('start the feeding', error)) return;
    if (data) setFeedings(prev => [toFeeding(data), ...prev]);
  }, [babyProfileId, caregiver]);

  const stopFeeding = useCallback(async (notes = '') => {
    const active = feedings.find(f => !f.endTime);
    if (!active) return;
    const now = new Date().toISOString();
    const dur = Math.floor((new Date(now).getTime() - new Date(active.startTime).getTime()) / 1000);
    const { error } = await table('feeding_sessions').update({ end_time: now, duration_seconds: dur, notes: notes || active.notes }).eq('id', active.id);
    if (writeFailed('stop the feeding', error)) return;
    setFeedings(prev => prev.map(f => f.id === active.id ? { ...f, endTime: now, durationSeconds: dur, notes: notes || f.notes } : f));
  }, [feedings]);

  const deleteFeeding = useCallback(async (id: string) => {
    const { error } = await table('feeding_sessions').delete().eq('id', id);
    if (writeFailed('delete the feeding', error)) return;
    setFeedings(prev => prev.filter(f => f.id !== id));
  }, []);

  const addPastFeeding = useCallback(async (f: Omit<FeedingSession, 'id'>) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('feeding_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: f.startTime, end_time: f.endTime, duration_seconds: f.durationSeconds,
      side: f.side, notes: f.notes,
    }).select().single();
    if (writeFailed('save the feeding', error)) return;
    if (data) setFeedings(prev => [toFeeding(data), ...prev].sort(byStartDesc));
  }, [babyProfileId, caregiver]);

  const updateFeeding = useCallback(async (id: string, updates: Partial<FeedingSession>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.startTime !== undefined) dbUpdates.start_time = updates.startTime;
    if (updates.endTime !== undefined) dbUpdates.end_time = updates.endTime;
    if (updates.durationSeconds !== undefined) dbUpdates.duration_seconds = updates.durationSeconds;
    if (updates.side !== undefined) dbUpdates.side = updates.side;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    const { error } = await table('feeding_sessions').update(dbUpdates).eq('id', id);
    if (writeFailed('update the feeding', error)) return;
    setFeedings(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  // ── Diaper CRUD ──
  const logDiaper = useCallback(async (type: DiaperType, colorNote: ColorNote | null = null, notes = '') => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('diaper_changes').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      timestamp: new Date().toISOString(), type, color_note: colorNote, notes,
    }).select().single();
    if (writeFailed('save the diaper change', error)) return;
    if (data) setDiapers(prev => [toDiaper(data), ...prev]);
  }, [babyProfileId, caregiver]);

  const deleteDiaper = useCallback(async (id: string) => {
    const { error } = await table('diaper_changes').delete().eq('id', id);
    if (writeFailed('delete the diaper change', error)) return;
    setDiapers(prev => prev.filter(d => d.id !== id));
  }, []);

  const addPastDiaper = useCallback(async (d: Omit<DiaperChange, 'id'>) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('diaper_changes').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      timestamp: d.timestamp, type: d.type, color_note: d.colorNote, notes: d.notes,
    }).select().single();
    if (writeFailed('save the diaper change', error)) return;
    if (data) setDiapers(prev => [toDiaper(data), ...prev].sort(byTimestampDesc));
  }, [babyProfileId, caregiver]);

  const updateDiaper = useCallback(async (id: string, updates: Partial<DiaperChange>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.timestamp !== undefined) dbUpdates.timestamp = updates.timestamp;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.colorNote !== undefined) dbUpdates.color_note = updates.colorNote;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    const { error } = await table('diaper_changes').update(dbUpdates).eq('id', id);
    if (writeFailed('update the diaper change', error)) return;
    setDiapers(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
  }, []);

  // ── Sleep CRUD ──
  const startSleep = useCallback(async () => {
    if (!babyProfileId || !caregiver) return;
    const hour = new Date().getHours();
    const sleepType: SleepType = (hour >= 19 || hour < 6) ? 'night' : 'nap';
    const { data, error } = await table('sleep_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: new Date().toISOString(), sleep_type: sleepType,
    }).select().single();
    if (writeFailed('start the sleep', error)) return;
    if (data) setSleeps(prev => [toSleep(data), ...prev]);
  }, [babyProfileId, caregiver]);

  const stopSleep = useCallback(async (notes = '', sleepType?: SleepType) => {
    const active = sleeps.find(s => !s.endTime);
    if (!active) return;
    const now = new Date().toISOString();
    const dur = Math.floor((new Date(now).getTime() - new Date(active.startTime).getTime()) / 1000);
    const updates: Record<string, unknown> = { end_time: now, duration_seconds: dur, notes: notes || active.notes };
    if (sleepType) updates.sleep_type = sleepType;
    const { error } = await table('sleep_sessions').update(updates).eq('id', active.id);
    if (writeFailed('stop the sleep', error)) return;
    setSleeps(prev => prev.map(s => s.id === active.id ? { ...s, endTime: now, durationSeconds: dur, notes: notes || s.notes, sleepType: sleepType || s.sleepType } : s));
  }, [sleeps]);

  const deleteSleep = useCallback(async (id: string) => {
    const { error } = await table('sleep_sessions').delete().eq('id', id);
    if (writeFailed('delete the sleep', error)) return;
    setSleeps(prev => prev.filter(s => s.id !== id));
  }, []);

  const addPastSleep = useCallback(async (s: Omit<SleepSession, 'id'>) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('sleep_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: s.startTime, end_time: s.endTime, duration_seconds: s.durationSeconds,
      sleep_type: s.sleepType, notes: s.notes,
    }).select().single();
    if (writeFailed('save the sleep', error)) return;
    if (data) setSleeps(prev => [toSleep(data), ...prev].sort(byStartDesc));
  }, [babyProfileId, caregiver]);

  const updateSleep = useCallback(async (id: string, updates: Partial<SleepSession>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.startTime !== undefined) dbUpdates.start_time = updates.startTime;
    if (updates.endTime !== undefined) dbUpdates.end_time = updates.endTime;
    if (updates.durationSeconds !== undefined) dbUpdates.duration_seconds = updates.durationSeconds;
    if (updates.sleepType !== undefined) dbUpdates.sleep_type = updates.sleepType;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    const { error } = await table('sleep_sessions').update(dbUpdates).eq('id', id);
    if (writeFailed('update the sleep', error)) return;
    setSleeps(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  // ── Pumping CRUD ──
  const startPumping = useCallback(async (side: Side) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('pumping_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: new Date().toISOString(), side,
    }).select().single();
    if (writeFailed('start the pumping session', error)) return;
    if (data) setPumpings(prev => [toPumping(data), ...prev]);
  }, [babyProfileId, caregiver]);

  const stopPumping = useCallback(async (volumeOz: number | null = null, notes = '') => {
    const active = pumpings.find(p => !p.endTime);
    if (!active) return;
    const now = new Date().toISOString();
    const dur = Math.floor((new Date(now).getTime() - new Date(active.startTime).getTime()) / 1000);
    const updates: Record<string, unknown> = { end_time: now, duration_seconds: dur, notes: notes || active.notes };
    if (volumeOz !== null) updates.volume_oz = volumeOz;
    const { error } = await table('pumping_sessions').update(updates).eq('id', active.id);
    if (writeFailed('stop the pumping session', error)) return;
    setPumpings(prev => prev.map(p => p.id === active.id ? { ...p, endTime: now, durationSeconds: dur, volumeOz: volumeOz ?? p.volumeOz, notes: notes || p.notes } : p));
  }, [pumpings]);

  const deletePumping = useCallback(async (id: string) => {
    const { error } = await table('pumping_sessions').delete().eq('id', id);
    if (writeFailed('delete the pumping session', error)) return;
    setPumpings(prev => prev.filter(p => p.id !== id));
  }, []);

  const addPastPumping = useCallback(async (p: Omit<PumpingSession, 'id'>) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('pumping_sessions').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      start_time: p.startTime, end_time: p.endTime, duration_seconds: p.durationSeconds,
      side: p.side, volume_oz: p.volumeOz, notes: p.notes,
    }).select().single();
    if (writeFailed('save the pumping session', error)) return;
    if (data) setPumpings(prev => [toPumping(data), ...prev].sort(byStartDesc));
  }, [babyProfileId, caregiver]);

  const updatePumping = useCallback(async (id: string, updates: Partial<PumpingSession>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.startTime !== undefined) dbUpdates.start_time = updates.startTime;
    if (updates.endTime !== undefined) dbUpdates.end_time = updates.endTime;
    if (updates.durationSeconds !== undefined) dbUpdates.duration_seconds = updates.durationSeconds;
    if (updates.side !== undefined) dbUpdates.side = updates.side;
    if (updates.volumeOz !== undefined) dbUpdates.volume_oz = updates.volumeOz;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    const { error } = await table('pumping_sessions').update(dbUpdates).eq('id', id);
    if (writeFailed('update the pumping session', error)) return;
    setPumpings(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
  }, []);

  // ── Bottle Feed CRUD ──
  const logBottleFeed = useCallback(async (amountOz: number, contentType: ContentType, notes = '', timestamp?: string) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('bottle_feeds').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      timestamp: timestamp || new Date().toISOString(), amount_oz: amountOz,
      content_type: contentType, notes,
    }).select().single();
    if (writeFailed('save the bottle feed', error)) return;
    if (data) setBottleFeeds(prev => [toBottle(data), ...prev].sort(byTimestampDesc));
  }, [babyProfileId, caregiver]);

  const deleteBottleFeed = useCallback(async (id: string) => {
    const { error } = await table('bottle_feeds').delete().eq('id', id);
    if (writeFailed('delete the bottle feed', error)) return;
    setBottleFeeds(prev => prev.filter(b => b.id !== id));
  }, []);

  const addPastBottleFeed = useCallback(async (b: Omit<BottleFeed, 'id'>) => {
    if (!babyProfileId || !caregiver) return;
    const { data, error } = await table('bottle_feeds').insert({
      baby_profile_id: babyProfileId, caregiver_id: caregiver.id,
      timestamp: b.timestamp, amount_oz: b.amountOz,
      content_type: b.contentType, notes: b.notes,
    }).select().single();
    if (writeFailed('save the bottle feed', error)) return;
    if (data) setBottleFeeds(prev => [toBottle(data), ...prev].sort(byTimestampDesc));
  }, [babyProfileId, caregiver]);

  const updateBottleFeed = useCallback(async (id: string, updates: Partial<BottleFeed>) => {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.timestamp !== undefined) dbUpdates.timestamp = updates.timestamp;
    if (updates.amountOz !== undefined) dbUpdates.amount_oz = updates.amountOz;
    if (updates.contentType !== undefined) dbUpdates.content_type = updates.contentType;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    const { error } = await table('bottle_feeds').update(dbUpdates).eq('id', id);
    if (writeFailed('update the bottle feed', error)) return;
    setBottleFeeds(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
  }, []);

  return (
    <AppContext.Provider value={{
      profile, setProfile: setProfileFn,
      feedings, activeFeeding, startFeeding, stopFeeding, deleteFeeding, addPastFeeding, updateFeeding,
      diapers, logDiaper, deleteDiaper, addPastDiaper, updateDiaper,
      sleeps, activeSleep, startSleep, stopSleep, deleteSleep, addPastSleep, updateSleep,
      pumpings, activePumping, startPumping, stopPumping, deletePumping, addPastPumping, updatePumping,
      bottleFeeds, logBottleFeed, deleteBottleFeed, addPastBottleFeed, updateBottleFeed,
      caregiver, caregivers, removeCaregiver, babyProfileId, familyId, loading,
      hasOlderHistory: historyCutoff !== null, loadingOlderHistory, loadAllHistory,
    }}>
      {children}
    </AppContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- existing pattern
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
