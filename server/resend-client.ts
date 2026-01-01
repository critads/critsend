// Resend HTTP API client for test emails
// Uses Replit's Resend integration for secure API key management

import { Resend } from 'resend';

let connectionSettings: any;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('Resend integration not available in this environment');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key)) {
    throw new Error('Resend not connected. Please set up the Resend integration.');
  }
  return {
    apiKey: connectionSettings.settings.api_key, 
    fromEmail: connectionSettings.settings.from_email
  };
}

// Get a fresh Resend client (never cache - tokens can expire)
export async function getResendClient() {
  const { apiKey, fromEmail } = await getCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail: fromEmail
  };
}

// Send a test email using Resend HTTP API
export async function sendTestEmailViaResend(options: {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  htmlContent: string;
  replyTo?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const { client } = await getResendClient();
    
    const fromAddress = options.fromName 
      ? `${options.fromName} <${options.fromEmail}>`
      : options.fromEmail;
    
    const result = await client.emails.send({
      from: fromAddress,
      to: [options.to],
      subject: options.subject,
      html: options.htmlContent,
      replyTo: options.replyTo || options.fromEmail,
    });
    
    if (result.error) {
      console.error('[RESEND API] Error:', result.error);
      return { 
        success: false, 
        error: result.error.message || 'Failed to send via Resend API' 
      };
    }
    
    console.log('[RESEND API] Test email sent successfully:', result.data?.id);
    return { 
      success: true, 
      messageId: result.data?.id 
    };
  } catch (error: any) {
    console.error('[RESEND API] Error sending test email:', error);
    return { 
      success: false, 
      error: error.message || 'Failed to send test email via Resend API' 
    };
  }
}
