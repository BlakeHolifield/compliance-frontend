import React from 'react';
import ComplianceEmptyState from '../ComplianceEmptyState';
import { BackgroundLink, LinkButton } from 'PresentationalComponents';

const ReportsEmptyState = () => (
  <ComplianceEmptyState
    title={'No policies are reporting'}
    mainButton={
      <BackgroundLink
        to="/scappolicies/new"
        component={LinkButton}
        variant="primary"
        ouiaId="CreateNewPolicyButton"
      >
        Create new policy
      </BackgroundLink>
    }
  />
);

export default ReportsEmptyState;
