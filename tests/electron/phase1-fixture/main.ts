import {app} from 'electron';
import {startHost} from '../../../src/main/host';
import {createSyntheticSummaryWorkflowForTests} from '../../../src/summary/workflow';
import {fixtureTransport} from './transport';

// This entry is test-only. The production entry does not read these variables.
const control=process.env.NOTE_APP_PHASE1_TEST_CONTROL;
const log=process.env.NOTE_APP_PHASE1_TEST_TRANSPORT_LOG;
if(!control||!log)throw new Error('Explicit synthetic fixture control is required');
app.setName('note-app');
startHost({summaryFactory:options=>createSyntheticSummaryWorkflowForTests({...options,transport:fixtureTransport(control,log)})});
