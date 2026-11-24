import { 
  getFirestore, 
  collection, 
  addDoc, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const db = getFirestore();

/**
 * Creates an audit log entry directly from the browser app.
 */
export async function logAuditEvent({ action, performedBy, target = null, details = null }) {
  try {
    const logData = {
      action: action,
      performedBy: {
        uid: performedBy?.uid || 'UNKNOWN',
        role: performedBy?.role || 'N/A'
      },
      target: target ? {
        id: target.id || null,
        type: target.type || null,
        email: target.email || null
      } : null,
      details: details || {},
      timestamp: serverTimestamp()
    };

    await addDoc(collection(db, 'audit_logs'), logData);
    console.log(`[AuditLog] Successfully logged: ${action}`);
    return true;
  } catch (error) {
    console.error('[AuditLog Error] Failed to record log:', error);
    return false;
  }
}