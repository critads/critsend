// Resend HTTP API client for test emails
// Uses Replit's Resend integration for secure API key management

import { Resend } from 'resend';
import { logger } from "./logger";

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

// Build email footer with unsubscribe link and company address
function buildEmailFooter(options: {
  unsubscribeText?: string;
  companyAddress?: string;
  unsubscribeUrl?: string;
}): string {
  const parts: string[] = [];
  
  if (options.unsubscribeUrl && options.unsubscribeText) {
    parts.push(`<a href="${options.unsubscribeUrl}" style="color: #666; text-decoration: underline;">${options.unsubscribeText}</a>`);
  }
  
  if (options.companyAddress) {
    parts.push(`<span style="color: #888;">${options.companyAddress}</span>`);
  }
  
  if (parts.length === 0) {
    return '';
  }
  
  return `
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #666;">
      ${parts.join(' | ')}
    </div>
  `;
}

// Send a test email using Resend HTTP API
export async function sendTestEmailViaResend(options: {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  htmlContent: string;
  replyTo?: string;
  preheader?: string;
  companyAddress?: string;
  unsubscribeText?: string;
  trackingDomain?: string;
  headers?: Record<string, string>;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const { client } = await getResendClient();
    
    const fromAddress = options.fromName 
      ? `${options.fromName} <${options.fromEmail}>`
      : options.fromEmail;
    
    // Build the complete HTML content
    let finalHtml = options.htmlContent;
    
    // Add preheader if provided
    if (options.preheader) {
      const preheaderHtml = `<span style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${options.preheader}</span>`;
      finalHtml = preheaderHtml + finalHtml;
    }
    
    // Build unsubscribe URL for test (using a placeholder since there's no real subscriber)
    let unsubscribeUrl: string | undefined;
    if (options.trackingDomain && options.unsubscribeText) {
      // For test emails, we use a dummy unsubscribe URL (it won't actually work but shows the format)
      const baseUrl = options.trackingDomain.replace(/\/$/, '');
      unsubscribeUrl = `${baseUrl}/api/unsubscribe/test-campaign/test-subscriber?sig=test`;
    }
    
    // Replace {{unsubscribe_url}} placeholder if present
    if (unsubscribeUrl && finalHtml.includes('{{unsubscribe_url}}')) {
      finalHtml = finalHtml.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
    }
    
    // Add footer with unsubscribe link and company address
    const footer = buildEmailFooter({
      unsubscribeText: options.unsubscribeText,
      companyAddress: options.companyAddress,
      unsubscribeUrl: unsubscribeUrl,
    });
    
    // Insert footer before closing body tag, or append at end
    if (finalHtml.includes('</body>')) {
      finalHtml = finalHtml.replace('</body>', footer + '</body>');
    } else {
      finalHtml = finalHtml + footer;
    }
    
    const result = await client.emails.send({
      from: fromAddress,
      to: [options.to],
      subject: options.subject,
      html: finalHtml,
      replyTo: options.replyTo || options.fromEmail,
      headers: options.headers,
    });
    
    if (result.error) {
      logger.error('Resend API error', { error: result.error });
      return { 
        success: false, 
        error: result.error.message || 'Failed to send via Resend API' 
      };
    }
    
    logger.info('Resend API test email sent successfully', { messageId: result.data?.id });
    return { 
      success: true, 
      messageId: result.data?.id 
    };
  } catch (error: any) {
    logger.error('Resend API error sending test email', { error: error.message || error });
    return { 
      success: false, 
      error: error.message || 'Failed to send test email via Resend API' 
    };
  }
}
